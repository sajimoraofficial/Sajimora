import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { CanonicalSet } from '../../../../core/src/sajimora/certified/canonicalEncoding';
import { ArtifactDomain } from '../../../../core/src/sajimora/certified/protocol';
import { produceTargetScopedEnvelope, verifyTargetScopedEnvelope, isNodeInTargetScopedEnvelope, isTargetImportDeclaration, shouldTraverseTargetScopedNode, verifyEnvelopeTargetDeclaration } from '../../../src/sajimora/certified/fragment/TargetScopedEnvelope';
import { F0BindingVerifier } from '../../../src/sajimora/certified/fragment/F0BindingVerifier';

const vertex = (fileId: string) => ({ projectId: 'p0', fileId });
const anchor = (fileId: string, start: number) => ({ projectId: 'p0', fileId, utf16Start: start, utf16End: start + 6, syntaxKind: 213 });

test('target envelope is bound to identity, closure, dependencies, and call site', () => {
  const envelope = produceTargetScopedEnvelope({
    targetIdentityRef: { domain: ArtifactDomain.IDENTITY, digest: 'a'.repeat(64) },
    targetLocalName: 'target',
    targetDeclaration: anchor('provider.ts', 0),
    signatureDependencyVertices: new CanonicalSet([vertex('provider.ts')]),
    implementationDependencyVertices: new CanonicalSet([vertex('provider.ts')]),
    consumerCallSiteAnchors: new CanonicalSet([anchor('consumer.ts', 60)]),
    closureRef: { domain: ArtifactDomain.CLOSURE, digest: 'b'.repeat(64) }
  });
  assert.equal(verifyTargetScopedEnvelope(envelope, [vertex('provider.ts'), vertex('consumer.ts')]), true);
  assert.equal(verifyTargetScopedEnvelope(envelope, [vertex('consumer.ts')]), false);
  assert.equal(verifyTargetScopedEnvelope({ ...envelope, digest: '0'.repeat(64) }, [vertex('provider.ts'), vertex('consumer.ts')]), false);
});

test('target envelope selects only target and consumer subtrees', () => {
  const source = ts.createSourceFile('provider.ts', 'export function target(x: string): string { return x; }\nexport function unrelated(): number { return 1; }', ts.ScriptTarget.Latest, true);
  const targetNode = source.statements[0];
  const unrelatedNode = source.statements[1];
  const envelope = produceTargetScopedEnvelope({
    targetIdentityRef: { domain: ArtifactDomain.IDENTITY, digest: 'a'.repeat(64) },
    targetLocalName: 'target',
    targetDeclaration: { projectId: 'p0', fileId: 'provider.ts', utf16Start: targetNode.getStart(source), utf16End: targetNode.getEnd(), syntaxKind: targetNode.kind },
    signatureDependencyVertices: new CanonicalSet([vertex('provider.ts')]),
    implementationDependencyVertices: new CanonicalSet([vertex('provider.ts')]),
    consumerCallSiteAnchors: new CanonicalSet([anchor('consumer.ts', 60)]),
    closureRef: { domain: ArtifactDomain.CLOSURE, digest: 'b'.repeat(64) }
  });
  assert.equal(isNodeInTargetScopedEnvelope(targetNode, source, envelope), true);
  assert.equal(isNodeInTargetScopedEnvelope(unrelatedNode, source, envelope), false);
  assert.equal(shouldTraverseTargetScopedNode(source, source, envelope), true);
  assert.equal(shouldTraverseTargetScopedNode(unrelatedNode, source, envelope), false);
});

test('binding scope selects the direct target import and excludes unrelated imports', () => {
  const text = 'import { target } from "./provider"; import * as ts from "typescript"; import { other } from "./other"; target();';
  const source = ts.createSourceFile('consumer.ts', text, ts.ScriptTarget.Latest, true);
  const callStart = text.indexOf('target()');
  const envelope = produceTargetScopedEnvelope({
    targetIdentityRef: { domain: ArtifactDomain.IDENTITY, digest: 'a'.repeat(64) },
    targetLocalName: 'target', targetDeclaration: anchor('provider.ts', 0),
    signatureDependencyVertices: new CanonicalSet([vertex('provider.ts')]), implementationDependencyVertices: new CanonicalSet([vertex('provider.ts')]),
    consumerCallSiteAnchors: new CanonicalSet([{ ...anchor('consumer.ts', callStart), utf16End: callStart + 'target()'.length, syntaxKind: ts.SyntaxKind.CallExpression }]), closureRef: { domain: ArtifactDomain.CLOSURE, digest: 'b'.repeat(64) }
  });
  const imports = source.statements.filter(ts.isImportDeclaration);
  assert.equal(isTargetImportDeclaration(imports[0], envelope), true);
  assert.equal(isTargetImportDeclaration(imports[1], envelope), false);
  assert.equal(isTargetImportDeclaration(imports[2], envelope), false);
});

test('envelope target declaration must match one exported function anchor', () => {
  const source = ts.createSourceFile('provider.ts', 'export function target(x: string): string { return x; }', ts.ScriptTarget.Latest, true);
  const declaration = source.statements[0];
  const envelope = produceTargetScopedEnvelope({
    targetIdentityRef: { domain: ArtifactDomain.IDENTITY, digest: 'a'.repeat(64) }, targetLocalName: 'target',
    targetDeclaration: { projectId: 'p0', fileId: 'provider.ts', utf16Start: declaration.getStart(source), utf16End: declaration.getEnd(), syntaxKind: declaration.kind },
    signatureDependencyVertices: new CanonicalSet([vertex('provider.ts')]), implementationDependencyVertices: new CanonicalSet([vertex('provider.ts')]),
    consumerCallSiteAnchors: new CanonicalSet([anchor('consumer.ts', 60)]), closureRef: { domain: ArtifactDomain.CLOSURE, digest: 'b'.repeat(64) }
  });
  assert.equal(verifyEnvelopeTargetDeclaration(vertex('provider.ts'), source, envelope), true);
  assert.equal(verifyEnvelopeTargetDeclaration(vertex('provider.ts'), source, { ...envelope, targetLocalName: 'missing' }), false);
});

test('scoped binding verifier accepts a matching local alias and rejects mismatched or non-relative imports', () => {
  const makeCase = (text: string) => {
    const source = ts.createSourceFile('consumer.ts', text, ts.ScriptTarget.Latest, true);
    let call: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => { if (ts.isCallExpression(node)) call = node; ts.forEachChild(node, visit); };
    visit(source);
    assert.ok(call);
    const envelope = produceTargetScopedEnvelope({
      targetIdentityRef: { domain: ArtifactDomain.IDENTITY, digest: 'a'.repeat(64) }, targetLocalName: 'target', targetDeclaration: anchor('provider.ts', 0),
      signatureDependencyVertices: new CanonicalSet([vertex('provider.ts')]), implementationDependencyVertices: new CanonicalSet([vertex('provider.ts')]),
      consumerCallSiteAnchors: new CanonicalSet([{ ...anchor('consumer.ts', call.getStart(source)), utf16End: call.getEnd(), syntaxKind: call.kind }]),
      closureRef: { domain: ArtifactDomain.CLOSURE, digest: 'b'.repeat(64) }
    });
    return F0BindingVerifier.verifyTargetScopedImport(vertex('consumer.ts'), source, envelope).valid;
  };
  assert.equal(makeCase('import { target } from "./provider"; target();'), true);
  assert.equal(makeCase('import { target as local } from "./provider"; local();'), true);
  assert.equal(makeCase('import { other as local } from "./provider"; local();'), false);
  assert.equal(makeCase('import { target } from "pkg"; target();'), false);
});
