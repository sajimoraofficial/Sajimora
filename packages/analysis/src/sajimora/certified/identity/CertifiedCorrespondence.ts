import * as crypto from 'node:crypto';
import ts from 'typescript';
import { CanonicalSymbolIdentity, CertifiedDeclarationCorrespondence } from '../../../../../core/src/sajimora/types/identity';
import { EnvironmentManifest } from '../../../../../core/src/sajimora/certified/contracts';
import { ArtifactDomain, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../../../../core/src/sajimora/certified/protocol';
import { canonicalEncode, hashContract, computeDomainSeparatedHash } from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { SealedFilesystem } from '../environment/SealedFilesystem';

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const normalizedText = (node: ts.Node, sf: ts.SourceFile) => node.getText(sf)
  .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/\s+/g, ' ')
  .replace(/\b[A-Za-z_$][\w$]*\b(?=\s*[({<])/g, '<name>').trim();

/** Replays the Phase 3 declaration key from sealed source, without trusting a mapping status. */
function indexFile(manifest: EnvironmentManifest, fs: SealedFilesystem, path: string): CanonicalSymbolIdentity[] {
  if (!fs.exists(path)) return [];
  const project = manifest.projects.filter(p => p.roots.some(r => r.fileId === path));
  if (project.length !== 1) return [];
  const projectId = project[0].projectId;
  const sf = ts.createSourceFile(path, fs.readBytes(path).toString('utf8'), ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (((sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []).length) return [];
  const out: CanonicalSymbolIdentity[] = [];
  const ordinals = new Map<string, number>();
  const visit = (node: ts.Node, owners: string[]) => {
    let name: string | undefined;
    let kind: string | undefined;
    let params = '';
    let functionLike = false;
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
      functionLike = true;
      name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
      kind = ts.SyntaxKind[node.kind];
      params = node.parameters.map(p => p.type?.getText(sf) ?? '?').join(',');
    } else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      name = node.name?.text;
      kind = ts.SyntaxKind[node.kind];
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent)) {
      name = node.name.text;
      kind = 'VariableDeclaration';
    }
    const nextOwners = name && (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) ? [...owners, name] : owners;
    if (name && kind) {
      const key = `${owners.join('.')}:${kind}:${name}`;
      const ordinal = ordinals.get(key) ?? 0;
      ordinals.set(key, ordinal + 1);
      const pos = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const end = sf.getLineAndCharacterOfPosition(node.getEnd());
      const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
      const exported = modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ??
        (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) &&
          ts.isVariableStatement(node.parent.parent) && !!node.parent.parent.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
      out.push({
        identityId: sha(`${projectId}|${path}|${owners.join('.')}|${kind}|${name}|${ordinal}`),
        projectId, moduleIdentity: path, ownerChain: owners, localName: name,
        declarationKind: kind, declarationOrdinal: ordinal,
        sourceSpan: { start: node.getStart(sf), end: node.getEnd(), line: pos.line + 1,
          column: pos.character + 1, endLine: end.line + 1, endColumn: end.character + 1 },
        exportPaths: exported ? [`${path}#${name}`] : [], parameterShape: params,
        astFingerprint: sha(normalizedText(node, sf))
      });
    }
    if (!functionLike) ts.forEachChild(node, child => visit(child, nextOwners));
  };
  visit(sf, []);
  return out;
}

function body(record: Omit<CertifiedDeclarationCorrespondence, 'digest'>): Omit<CertifiedDeclarationCorrespondence, 'digest'> {
  return record;
}

export class CertifiedCorrespondence {
  /** Returns the unique sealed parent declaration key without asserting a
   * cross-version correspondence.  Used only by the F0 deletion witness. */
  static parentIdentity(manifest: EnvironmentManifest, fs: SealedFilesystem,
    path: string, targetIdentityId: string): CanonicalSymbolIdentity | null {
    const matches = indexFile(manifest, fs, path).filter(item => item.identityId === targetIdentityId);
    return matches.length === 1 ? matches[0] : null;
  }
  /** Produces a proposed correspondence only for a unique stable declaration key. */
  static produce(parentManifest: EnvironmentManifest, candidateManifest: EnvironmentManifest,
    parentFs: SealedFilesystem, candidateFs: SealedFilesystem, path: string, targetIdentityId: string): CertifiedDeclarationCorrespondence | null {
    if (!parentFs.exists(path) || !candidateFs.exists(path)) return null;
    const parents = indexFile(parentManifest, parentFs, path).filter(x => x.identityId === targetIdentityId);
    if (parents.length !== 1) return null;
    const parent = parents[0];
    const candidates = indexFile(candidateManifest, candidateFs, path).filter(x =>
      x.projectId === parent.projectId && x.moduleIdentity === parent.moduleIdentity &&
      canonicalEncode(x.ownerChain) === canonicalEncode(parent.ownerChain) &&
      x.localName === parent.localName && x.declarationKind === parent.declarationKind &&
      x.declarationOrdinal === parent.declarationOrdinal &&
      canonicalEncode(x.exportPaths) === canonicalEncode(parent.exportPaths));
    if (candidates.length !== 1) return null;
    const parentFileDigest = computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, parentFs.readBytes(path));
    const candidateFileDigest = computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, candidateFs.readBytes(path));
    if (parentManifest.namespace.files.filter(f => f.logicalPath === path && f.bytesRef.digest === parentFileDigest).length !== 1 ||
        candidateManifest.namespace.files.filter(f => f.logicalPath === path && f.bytesRef.digest === candidateFileDigest).length !== 1) return null;
    if (parentFileDigest === candidateFileDigest) return null;
    const parentBytes = parentFs.readBytes(path);
    const candidateBytes = candidateFs.readBytes(path);
    let prefix = 0;
    while (prefix < Math.min(parentBytes.length, candidateBytes.length) && parentBytes[prefix] === candidateBytes[prefix]) prefix++;
    let suffix = 0;
    while (suffix < Math.min(parentBytes.length - prefix, candidateBytes.length - prefix) &&
      parentBytes[parentBytes.length - suffix - 1] === candidateBytes[candidateBytes.length - suffix - 1]) suffix++;
    const diffEvidence = {
      parentChangedStart: prefix, parentChangedEnd: parentBytes.length - suffix,
      candidateChangedStart: prefix, candidateChangedEnd: candidateBytes.length - suffix,
      parentChangedDigest: computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1,
        parentBytes.subarray(prefix, parentBytes.length - suffix)),
      candidateChangedDigest: computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1,
        candidateBytes.subarray(prefix, candidateBytes.length - suffix))
    };
    const record = body({
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      parentEnvironmentDigest: hashContract(ArtifactDomain.MANIFEST, parentManifest.schemaVersion, parentManifest),
      candidateEnvironmentDigest: hashContract(ArtifactDomain.MANIFEST, candidateManifest.schemaVersion, candidateManifest),
      parentFileDigest, candidateFileDigest, parent, candidate: candidates[0], diffEvidence,
      diffDigest: hashContract(ArtifactDomain.IDENTITY, SAJIMORA_CERTIFIED_EVIDENCE_V1,
        { path, parentFileDigest, candidateFileDigest, diffEvidence })
    });
    return { ...record, digest: hashContract(ArtifactDomain.IDENTITY, SAJIMORA_CERTIFIED_EVIDENCE_V1, record) };
  }

  static verify(proposed: CertifiedDeclarationCorrespondence, parentManifest: EnvironmentManifest,
    candidateManifest: EnvironmentManifest, parentFs: SealedFilesystem, candidateFs: SealedFilesystem,
    targetIdentityId: string): boolean {
    try {
      const expected = this.produce(parentManifest, candidateManifest, parentFs, candidateFs,
        proposed?.parent?.moduleIdentity, targetIdentityId);
      return !!expected && canonicalEncode(expected) === canonicalEncode(proposed);
    } catch {
      return false;
    }
  }
}
