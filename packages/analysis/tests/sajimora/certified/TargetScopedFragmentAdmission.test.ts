import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { CanonicalSet, computeDomainSeparatedHash, hashContract } from '../../../../core/src/sajimora/certified/canonicalEncoding';
import { ArtifactDomain, SAJIMORA_CERTIFIED_EVIDENCE_V1 } from '../../../../core/src/sajimora/certified/protocol';
import { ArtifactRef } from '../../../../core/src/sajimora/certified/blockers';
import { DependencyClosureCertificate, FileEntry, Vertex } from '../../../../core/src/sajimora/certified/contracts';
import { FragmentAdmissionProducer } from '../../../src/sajimora/certified/fragment/FragmentAdmissionProducer';
import { FragmentAdmissionVerifier } from '../../../src/sajimora/certified/fragment/FragmentAdmissionVerifier';
import { produceTargetScopedEnvelope, TargetScopedEnvelope } from '../../../src/sajimora/certified/fragment/TargetScopedEnvelope';
import { SealedFilesystem } from '../../../src/sajimora/certified/environment/SealedFilesystem';
import { VerificationBudget } from '../../../src/sajimora/certified/proof/VerificationBudget';
import { INITIAL_RESOURCE_PROFILE } from '../../../../core/src/sajimora/certified/protocol';

type SourceMap = Record<string, string>;
const vertex = (fileId: string): Vertex => ({ projectId: 'p0', fileId });

function prepare(sources: SourceMap) {
  const files: FileEntry[] = [];
  const payloads: Array<{ digest: string; data: Buffer }> = [];
  for (const [fileId, content] of Object.entries(sources)) {
    const data = Buffer.from(content, 'utf8');
    const digest = computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, data);
    files.push({ fileId, logicalPath: fileId, byteLength: data.length, bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest }, mode: 0o644, kind: 'SOURCE', origin: 'GIT_OBJECT', provenanceRefs: [] });
    payloads.push({ digest, data });
  }
  const sealedFs = new SealedFilesystem(files, payloads, 'CASE_SENSITIVE');
  const vertices = Object.keys(sources).map(vertex);
  const envRef: ArtifactRef = { domain: ArtifactDomain.MANIFEST, digest: '1'.repeat(64) };
  const closure: DependencyClosureCertificate = {
    schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
    environmentRef: envRef,
    rootPolicyId: 'F0_TEST_ROOT',
    rootVertices: new CanonicalSet([vertex('provider.ts'), vertex('consumer.ts')]),
    reachedVertices: new CanonicalSet(vertices),
    dependencyEdgeRefs: new CanonicalSet(),
    resolutionFactRefs: new CanonicalSet(),
    augmentationFactRefs: new CanonicalSet(),
    declarationGroups: new CanonicalSet(),
    traversalCoverage: new CanonicalSet(),
    boundaryDischarges: new CanonicalSet(),
    ruleSetId: 'F0_TEST_RULES'
  };
  const closureRef: ArtifactRef = { domain: ArtifactDomain.CLOSURE, digest: hashContract(ArtifactDomain.CLOSURE, closure.schemaVersion, closure) };
  const provider = ts.createSourceFile('provider.ts', sources['provider.ts'], ts.ScriptTarget.Latest, true);
  const consumer = ts.createSourceFile('consumer.ts', sources['consumer.ts'], ts.ScriptTarget.Latest, true);
  const declaration = provider.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'target');
  let call: ts.CallExpression | undefined;
  const findCall = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) call = node;
    ts.forEachChild(node, findCall);
  };
  findCall(consumer);
  assert.ok(declaration && call, 'test sources must contain the declared target and consumer call');
  const envelope: TargetScopedEnvelope = produceTargetScopedEnvelope({
    targetIdentityRef: { domain: ArtifactDomain.IDENTITY, digest: 'a'.repeat(64) },
    targetLocalName: 'target',
    targetDeclaration: { projectId: 'p0', fileId: 'provider.ts', utf16Start: declaration.getStart(provider), utf16End: declaration.getEnd(), syntaxKind: declaration.kind },
    signatureDependencyVertices: new CanonicalSet([vertex('provider.ts')]),
    implementationDependencyVertices: new CanonicalSet([vertex('provider.ts')]),
    consumerCallSiteAnchors: new CanonicalSet([{ projectId: 'p0', fileId: 'consumer.ts', utf16Start: call.getStart(consumer), utf16End: call.getEnd(), syntaxKind: call.kind }]),
    closureRef
  });
  const admission = new FragmentAdmissionProducer(sealedFs).produceAdmission(envRef, closureRef, vertices, [], envelope);
  const verifier = new FragmentAdmissionVerifier(sealedFs, new VerificationBudget(INITIAL_RESOURCE_PROFILE), {
    closureCert: closure,
    enableTargetScopedAdmission: true,
    targetScopedEnvelope: envelope
  });
  return { admission, verifier };
}

test('scoped admission slices provider and consumer while fully checking other closure files', async t => {
  await t.test('ignores unrelated provider and consumer syntax but verifies target import and call', () => {
    const { admission, verifier } = prepare({
      'provider.ts': `import * as nodeApi from 'node:fs';\nexport function target(x: string): string { return x; }\nclass UnrelatedProviderSyntax {}`,
      'consumer.ts': `import { target } from './provider';\nimport * as nodeApi from 'node:path';\nclass UnrelatedConsumerSyntax {}\ntarget('ok');`
    });
    const result = verifier.verify(admission);
    assert.equal(result.status, 'VERIFIED', result.status === 'REJECTED' ? result.detail.message : '');
  });

  await t.test('rejects unsupported syntax in a reached dependency file', () => {
    const { admission, verifier } = prepare({
      'provider.ts': `export function target(x: string): string { return x; }`,
      'consumer.ts': `import { target } from './provider'; target('ok');`,
      'dependency.ts': `class UnsupportedDependencySyntax {}`
    });
    const result = verifier.verify(admission);
    assert.equal(result.status, 'REJECTED');
    if (result.status === 'REJECTED') assert.match(result.detail.message, /dependency\.ts.*ClassDeclaration|ClassDeclaration.*dependency\.ts/);
  });

  await t.test('accepts a local import alias through a named barrel chain', () => {
    const { admission, verifier } = prepare({
      'provider.ts': `export function target(x: string): string { return x; }`,
      'barrel.ts': `export { target as publicTarget } from './provider';`,
      'consumer.ts': `import { publicTarget as localTarget } from './barrel'; localTarget('ok');`
    });
    const result = verifier.verify(admission);
    assert.equal(result.status, 'VERIFIED', result.status === 'REJECTED' ? result.detail.message : '');
  });

  await t.test('rejects ambiguous barrel exports before admitting the target call', () => {
    const { admission, verifier } = prepare({
      'provider.ts': `export function target(x: string): string { return x; }`,
      'other.ts': `export function target(x: string): string { return x; }`,
      'barrel.ts': `export { target as publicTarget } from './provider';\nexport { target as publicTarget } from './other';`,
      'consumer.ts': `import { publicTarget as localTarget } from './barrel'; localTarget('ok');`
    });
    const result = verifier.verify(admission);
    assert.equal(result.status, 'REJECTED');
  });

  await t.test('rejects a mismatched provider and a cyclic barrel chain', () => {
    const mismatched = prepare({
      'provider.ts': `export function target(x: string): string { return x; }`,
      'other.ts': `export function target(x: string): string { return x; }`,
      'consumer.ts': `import { target } from './other'; target('ok');`
    });
    assert.equal(mismatched.verifier.verify(mismatched.admission).status, 'REJECTED');

    const cyclic = prepare({
      'provider.ts': `export function target(x: string): string { return x; }`,
      'barrel.ts': `export { target } from './cycle';`,
      'cycle.ts': `export { target } from './barrel';`,
      'consumer.ts': `import { target } from './barrel'; target('ok');`
    });
    assert.equal(cyclic.verifier.verify(cyclic.admission).status, 'REJECTED');
  });
});
