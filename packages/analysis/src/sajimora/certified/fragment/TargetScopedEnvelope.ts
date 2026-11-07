import { Anchor } from '../../../../../core/src/sajimora/certified/blockers';
import { ArtifactDomain } from '../../../../../core/src/sajimora/certified/protocol';
import { CanonicalSet, hashContract } from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { SchemaVersion } from '../../../../../core/src/sajimora/certified/protocol';
import { ArtifactRef } from '../../../../../core/src/sajimora/certified/blockers';
import { Vertex } from '../../../../../core/src/sajimora/certified/contracts';
import ts from 'typescript';
import { discoverUniqueExportedFunction } from './ModuleBindingDiscovery';

export interface TargetScopedEnvelope {
  schemaVersion: 'V33_TARGET_SCOPED_ENVELOPE_V1';
  targetIdentityRef: ArtifactRef;
  targetLocalName: string;
  targetDeclaration: Anchor;
  signatureDependencyVertices: CanonicalSet<Vertex>;
  implementationDependencyVertices: CanonicalSet<Vertex>;
  consumerCallSiteAnchors: CanonicalSet<Anchor>;
  closureRef: ArtifactRef;
  digest: string;
}

export function produceTargetScopedEnvelope(input: Omit<TargetScopedEnvelope, 'schemaVersion' | 'digest'>): TargetScopedEnvelope {
  if (!input.targetIdentityRef.digest || !input.closureRef.digest) throw new Error('Target envelope requires identity and closure references');
  if (!input.targetLocalName) throw new Error('Target envelope requires a local symbol name');
  if (input.targetDeclaration.fileId.length === 0) throw new Error('Target envelope requires a declaration anchor');
  if (input.consumerCallSiteAnchors.size === 0) throw new Error('Target envelope requires a consumer call-site anchor');
  const body = { schemaVersion: 'V33_TARGET_SCOPED_ENVELOPE_V1' as const, ...input };
  return { ...body, digest: hashContract(ArtifactDomain.ADMISSION, body.schemaVersion as SchemaVersion, body) };
}

export function verifyTargetScopedEnvelope(envelope: TargetScopedEnvelope, closureVertices: Iterable<Vertex>): boolean {
  const allowed = new Set([...closureVertices].map(vertex => `${vertex.projectId}:${vertex.fileId}`));
  const deps = [...envelope.signatureDependencyVertices, ...envelope.implementationDependencyVertices];
  if (deps.some(vertex => !allowed.has(`${vertex.projectId}:${vertex.fileId}`))) return false;
  const expected = hashContract(ArtifactDomain.ADMISSION, envelope.schemaVersion as SchemaVersion, {
    schemaVersion: envelope.schemaVersion,
    targetIdentityRef: envelope.targetIdentityRef,
    targetLocalName: envelope.targetLocalName,
    targetDeclaration: envelope.targetDeclaration,
    signatureDependencyVertices: envelope.signatureDependencyVertices,
    implementationDependencyVertices: envelope.implementationDependencyVertices,
    consumerCallSiteAnchors: envelope.consumerCallSiteAnchors,
    closureRef: envelope.closureRef
  });
  return expected === envelope.digest;
}

/** Returns whether an AST node belongs to the declared target/call-site envelope. */
export function isNodeInTargetScopedEnvelope(node: ts.Node, sourceFile: ts.SourceFile, envelope: TargetScopedEnvelope): boolean {
  if (node.getSourceFile() !== sourceFile) return false;
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const ranges = [envelope.targetDeclaration, ...envelope.consumerCallSiteAnchors]
    .filter(anchor => anchor.fileId === sourceFile.fileName)
    .map(anchor => [anchor.utf16Start, anchor.utf16End] as const);
  return ranges.some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd);
}

export function shouldTraverseTargetScopedNode(node: ts.Node, sourceFile: ts.SourceFile, envelope: TargetScopedEnvelope): boolean {
  // The source-file root is always traversed so eligible descendants can be
  // reached; all other nodes must lie within an authenticated envelope range.
  if (ts.isSourceFile(node)) return true;
  const isAnchorFile = sourceFile.fileName === envelope.targetDeclaration.fileId ||
    Array.from(envelope.consumerCallSiteAnchors).some(anchor => anchor.fileId === sourceFile.fileName);
  // Target scoping limits only provider and consumer files. Every other file
  // reached through the verified dependency closure remains exhaustive.
  if (!isAnchorFile) return true;
  if (isTargetImportDeclaration(node, envelope)) return true;
  const ranges = [envelope.targetDeclaration, ...envelope.consumerCallSiteAnchors]
    .filter(anchor => anchor.fileId === sourceFile.fileName)
    .map(anchor => [anchor.utf16Start, anchor.utf16End] as const);
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  return ranges.some(([rangeStart, rangeEnd]) =>
    (start >= rangeStart && end <= rangeEnd) || (start <= rangeStart && end >= rangeEnd));
}

/** Identifies the only import declaration eligible for scoped binding validation. */
export function isTargetImportDeclaration(node: ts.Node, envelope: TargetScopedEnvelope): boolean {
  if (!ts.isImportDeclaration(node) || !node.importClause || !ts.isStringLiteral(node.moduleSpecifier)) return false;
  const bindings = node.importClause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) return false;
  const sourceFile = node.getSourceFile();
  const callAnchor = Array.from(envelope.consumerCallSiteAnchors).find(anchor => anchor.fileId === sourceFile.fileName);
  if (!callAnchor) return false;
  const call = findCallAtAnchor(sourceFile, callAnchor);
  const callName = call && ts.isIdentifier(call.expression) ? call.expression.text : undefined;
  return !!callName && bindings.elements.some(element => element.name.text === callName);
}

function findCallAtAnchor(sourceFile: ts.SourceFile, anchor: Anchor): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.getStart(sourceFile) === anchor.utf16Start && node.getEnd() === anchor.utf16End) {
      found = node;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function verifyEnvelopeTargetDeclaration(vertex: { projectId: string; fileId: string }, sourceFile: ts.SourceFile, envelope: TargetScopedEnvelope): boolean {
  const declaration = discoverUniqueExportedFunction(vertex, sourceFile, envelope.targetLocalName);
  if (!declaration) return false;
  return declaration.anchor.utf16Start === envelope.targetDeclaration.utf16Start &&
    declaration.anchor.utf16End === envelope.targetDeclaration.utf16End &&
    declaration.anchor.fileId === envelope.targetDeclaration.fileId;
}
