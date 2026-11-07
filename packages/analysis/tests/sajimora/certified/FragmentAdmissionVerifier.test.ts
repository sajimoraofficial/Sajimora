import { test } from 'node:test';
import * as assert from 'node:assert';
import { FragmentAdmissionVerifier } from '../../../src/sajimora/certified/fragment/FragmentAdmissionVerifier';
import { FragmentAdmissionProducer } from '../../../src/sajimora/certified/fragment/FragmentAdmissionProducer';
import { SealedFilesystem } from '../../../src/sajimora/certified/environment/SealedFilesystem';
import { VerificationBudget } from '../../../src/sajimora/certified/proof/VerificationBudget';
import {
  INITIAL_RESOURCE_PROFILE,
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1
} from '../../../../core/src/sajimora/certified/protocol';
import { BlockerCode, ArtifactRef } from '../../../../core/src/sajimora/certified/blockers';
import { Vertex, FileEntry } from '../../../../core/src/sajimora/certified/contracts';
import { CanonicalSet, computeDomainSeparatedHash } from '../../../../core/src/sajimora/certified/canonicalEncoding';
import ts from 'typescript';

function createSealedFs(files: { path: string; content: string }[]): SealedFilesystem {
  const fileEntries: FileEntry[] = files.map(f => {
    const buf = Buffer.from(f.content, 'utf8');
    const digest = computeDomainSeparatedHash(
      ArtifactDomain.SOURCE_BYTES,
      SAJIMORA_CERTIFIED_EVIDENCE_V1,
      buf
    );
    return {
      fileId: f.path,
      logicalPath: f.path,
      byteLength: buf.length,
      bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest },
      mode: 0o644,
      kind: 'SOURCE',
      origin: 'GIT_OBJECT',
      provenanceRefs: []
    };
  });

  const dataEntries = files.map(f => {
    const buf = Buffer.from(f.content, 'utf8');
    const digest = computeDomainSeparatedHash(
      ArtifactDomain.SOURCE_BYTES,
      SAJIMORA_CERTIFIED_EVIDENCE_V1,
      buf
    );
    return { digest, data: buf };
  });

  return new SealedFilesystem(fileEntries, dataEntries, 'CASE_SENSITIVE');
}

test('FragmentAdmissionVerifier - Comprehensive Production Matrix & Adversarial Suite', async (t) => {
  const envRef: ArtifactRef = { domain: ArtifactDomain.MANIFEST, digest: '1111111111111111111111111111111111111111111111111111111111111111' };
  const closureRef: ArtifactRef = { domain: ArtifactDomain.CLOSURE, digest: '2222222222222222222222222222222222222222222222222222222222222222' };

  await t.test('successfully verifies sound F0 program with valid FragmentAdmissionCertificate', () => {
    const v1: Vertex = { projectId: 'p1', fileId: 'src/main.ts' };
    const src = `
      export type ID = string | number;
      export interface User {
        readonly id: ID;
        readonly name: string;
      }
      export function formatUser(u: User): string {
        return u.name;
      }
      const defaultUser: User = {
        id: 1,
        name: "Alice"
      };
      export const formatted: string = formatUser(defaultUser);
    `;
    const sealedFs = createSealedFs([{ path: v1.fileId, content: src }]);

    const producer = new FragmentAdmissionProducer(sealedFs);
    const cert = producer.produceAdmission(envRef, closureRef, [v1]);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new FragmentAdmissionVerifier(sealedFs, budget);

    const res = verifier.verify(cert);
    assert.strictEqual(res.status, 'VERIFIED');
    if (res.status === 'VERIFIED') {
      assert.strictEqual(res.verifiedClaim, 'FRAGMENT_ADMISSION_VERIFIED');
    }
  });

  await t.test('admits initialized single-assignment let and rejects mutable or uninitialized bindings', () => {
    const cases = [
      { src: 'let x: number = 10; const result: number = x;', expected: 'VERIFIED' },
      { src: 'var y: string = "hello";', expected: 'REJECTED' },
      { src: 'let z: number;', expected: 'REJECTED' },
      { src: 'let count: number = 0; count = 1;', expected: 'REJECTED' },
      { src: 'let count: number = 0; count++;', expected: 'REJECTED' },
      { src: 'let value: number = 0; eval("value = 1");', expected: 'REJECTED' }
    ] as const;

    for (const [index, { src, expected }] of cases.entries()) {
      const v: Vertex = { projectId: 'p1', fileId: 'src/var.ts' };
      const sealedFs = createSealedFs([{ path: v.fileId, content: src }]);

      const producer = new FragmentAdmissionProducer(sealedFs);
      const cert = producer.produceAdmission(envRef, closureRef, [v]);

      const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
      const verifier = new FragmentAdmissionVerifier(sealedFs, budget);
      const res = verifier.verify(cert);

      assert.strictEqual(res.status, expected, `case ${index + 1}: ${src}`);
      if (expected === 'REJECTED' && res.status === 'REJECTED') {
        assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_SYNTAX);
      }
    }
  });

  await t.test('rejects mutable or optional interface properties with UNSUPPORTED_SYNTAX', () => {
    const testCases = [
      'interface Mutable { prop: string; }', // Missing readonly
      'interface Optional { readonly opt?: number; }' // Optional
    ];

    for (const src of testCases) {
      const v: Vertex = { projectId: 'p1', fileId: 'src/iface.ts' };
      const sealedFs = createSealedFs([{ path: v.fileId, content: src }]);

      const producer = new FragmentAdmissionProducer(sealedFs);
      const cert = producer.produceAdmission(envRef, closureRef, [v]);

      const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
      const verifier = new FragmentAdmissionVerifier(sealedFs, budget);
      const res = verifier.verify(cert);

      assert.strictEqual(res.status, 'REJECTED');
      if (res.status === 'REJECTED') {
        assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_SYNTAX);
      }
    }
  });

  await t.test('rejects empty interface with UNSUPPORTED_SYNTAX', () => {
    const v: Vertex = { projectId: 'p1', fileId: 'src/empty.ts' };
    const sealedFs = createSealedFs([{ path: v.fileId, content: 'interface Empty {}' }]);

    const producer = new FragmentAdmissionProducer(sealedFs);
    const cert = producer.produceAdmission(envRef, closureRef, [v]);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new FragmentAdmissionVerifier(sealedFs, budget);
    const res = verifier.verify(cert);

    assert.strictEqual(res.status, 'REJECTED');
    if (res.status === 'REJECTED') {
      assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_SYNTAX);
    }
  });

  await t.test('rejects control flow constructs (if, for, while, switch, try/catch) with UNSUPPORTED_SYNTAX', () => {
    const testCases = [
      'function f(x: number): number { if (x) return 1; return 0; }',
      'function f(x: number): number { for (let i = 0; i < 10; i++) {} return x; }',
      'function f(x: number): number { while (x > 0) {} return x; }',
      'function f(x: number): number { switch (x) { default: return 0; } }',
      'function f(): number { try { return 1; } catch (e) { return 0; } }'
    ];

    for (const src of testCases) {
      const v: Vertex = { projectId: 'p1', fileId: 'src/control.ts' };
      const sealedFs = createSealedFs([{ path: v.fileId, content: src }]);

      const producer = new FragmentAdmissionProducer(sealedFs);
      const cert = producer.produceAdmission(envRef, closureRef, [v]);

      const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
      const verifier = new FragmentAdmissionVerifier(sealedFs, budget);
      const res = verifier.verify(cert);

      assert.strictEqual(res.status, 'REJECTED');
      if (res.status === 'REJECTED') {
        assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_SYNTAX);
      }
    }
  });

  await t.test('rejects classes, generics, any, and unknown with UNSUPPORTED_SYNTAX', () => {
    const testCases = [
      'class MyClass { x: number = 1; }',
      'function genericFn<T>(x: T): T { return x; }',
      'type GenericType<T> = T | null;',
      'const a: any = 1;',
      'const u: unknown = 1;'
    ];

    for (const src of testCases) {
      const v: Vertex = { projectId: 'p1', fileId: 'src/features.ts' };
      const sealedFs = createSealedFs([{ path: v.fileId, content: src }]);

      const producer = new FragmentAdmissionProducer(sealedFs);
      const cert = producer.produceAdmission(envRef, closureRef, [v]);

      const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
      const verifier = new FragmentAdmissionVerifier(sealedFs, budget);
      const res = verifier.verify(cert);

      assert.strictEqual(res.status, 'REJECTED');
      if (res.status === 'REJECTED') {
        assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_SYNTAX);
      }
    }
  });

  await t.test('rejects circular type alias with CIRCULAR_TYPE_ALIAS', () => {
    const src = `
      type A = B;
      type B = A;
    `;
    const v: Vertex = { projectId: 'p1', fileId: 'src/cycle.ts' };
    const sealedFs = createSealedFs([{ path: v.fileId, content: src }]);

    const producer = new FragmentAdmissionProducer(sealedFs);
    const cert = producer.produceAdmission(envRef, closureRef, [v]);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new FragmentAdmissionVerifier(sealedFs, budget);
    const res = verifier.verify(cert);

    assert.strictEqual(res.status, 'REJECTED');
    if (res.status === 'REJECTED') {
      assert.strictEqual(res.blockerCode, BlockerCode.CIRCULAR_TYPE_ALIAS);
    }
  });

  await t.test('rejects tampered syntax coverage with HASH_MISMATCH', () => {
    const v: Vertex = { projectId: 'p1', fileId: 'src/tamper.ts' };
    const src = 'const x: number = 42;';
    const sealedFs = createSealedFs([{ path: v.fileId, content: src }]);

    const producer = new FragmentAdmissionProducer(sealedFs);
    const cert = producer.produceAdmission(envRef, closureRef, [v]);

    // Tamper with one entry in syntaxCoverage
    const entries = Array.from(cert.syntaxCoverage);
    entries[0] = {
      ...entries[0],
      admittedProductionId: 'F0_FORGED_PRODUCTION'
    };
    cert.syntaxCoverage = new CanonicalSet(entries);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new FragmentAdmissionVerifier(sealedFs, budget);
    const res = verifier.verify(cert);

    assert.strictEqual(res.status, 'REJECTED');
    if (res.status === 'REJECTED') {
      assert.strictEqual(res.blockerCode, BlockerCode.HASH_MISMATCH);
    }
  });

  await t.test('rejects omitted syntax coverage node with EDGE_OMISSION', () => {
    const v: Vertex = { projectId: 'p1', fileId: 'src/omit.ts' };
    const src = 'const x: number = 42;';
    const sealedFs = createSealedFs([{ path: v.fileId, content: src }]);

    const producer = new FragmentAdmissionProducer(sealedFs);
    const cert = producer.produceAdmission(envRef, closureRef, [v]);

    // Drop one node from coverage
    const entries = Array.from(cert.syntaxCoverage).slice(1);
    cert.syntaxCoverage = new CanonicalSet(entries);

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new FragmentAdmissionVerifier(sealedFs, budget);
    const res = verifier.verify(cert);

    assert.strictEqual(res.status, 'REJECTED');
    if (res.status === 'REJECTED') {
      assert.strictEqual(res.blockerCode, BlockerCode.EDGE_OMISSION);
    }
  });

  await t.test('rejects a deliberately omitted Case-B provider return node with EDGE_OMISSION', () => {
    const v: Vertex = { projectId: 'p0', fileId: 'provider.ts' };
    const src = 'export function calc(): number { return 2; }\n';
    const sealedFs = createSealedFs([{ path: v.fileId, content: src }]);
    const cert = new FragmentAdmissionProducer(sealedFs).produceAdmission(envRef, closureRef, [v]);
    const sourceFile = ts.createSourceFile(v.fileId, src, ts.ScriptTarget.Latest, true);
    let returnNode: ts.ReturnStatement | undefined;
    const visit = (node: ts.Node): void => { if (ts.isReturnStatement(node)) returnNode = node; ts.forEachChild(node, visit); };
    visit(sourceFile);
    assert.ok(returnNode);
    const missingId = `${returnNode!.kind}:${returnNode!.getStart(sourceFile)}:${returnNode!.getEnd()}`;
    cert.syntaxCoverage = new CanonicalSet(Array.from(cert.syntaxCoverage)
      .filter(entry => !(entry.vertex.fileId === v.fileId && entry.syntaxNodeId === missingId)));

    const result = new FragmentAdmissionVerifier(sealedFs, new VerificationBudget(INITIAL_RESOURCE_PROFILE)).verify(cert);
    assert.strictEqual(result.status, 'REJECTED');
    if (result.status === 'REJECTED') assert.strictEqual(result.blockerCode, BlockerCode.EDGE_OMISSION);
  });

  await t.test('rejects unsupported protocol or profile configuration', () => {
    const v: Vertex = { projectId: 'p1', fileId: 'src/proto.ts' };
    const sealedFs = createSealedFs([{ path: v.fileId, content: 'const x: number = 1;' }]);

    const producer = new FragmentAdmissionProducer(sealedFs);
    const cert = producer.produceAdmission(envRef, closureRef, [v]);

    // Test unsupported protocol
    const badProtoCert = { ...cert, schemaVersion: 'INVALID_VERSION' as any };
    const verifier1 = new FragmentAdmissionVerifier(sealedFs, new VerificationBudget(INITIAL_RESOURCE_PROFILE));
    const res1 = verifier1.verify(badProtoCert);
    assert.strictEqual(res1.status, 'REJECTED');
    if (res1.status === 'REJECTED') {
      assert.strictEqual(res1.blockerCode, BlockerCode.UNSUPPORTED_PROTOCOL);
    }

    // Test unsupported profile
    const badProfileCert = { ...cert, profileId: 'UNSUPPORTED_PROFILE' };
    const verifier2 = new FragmentAdmissionVerifier(sealedFs, new VerificationBudget(INITIAL_RESOURCE_PROFILE));
    const res2 = verifier2.verify(badProfileCert);
    assert.strictEqual(res2.status, 'REJECTED');
    if (res2.status === 'REJECTED') {
      assert.strictEqual(res2.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
    }
  });

  await t.test('enforces syntax nesting limit and fails with RESOURCE_EXHAUSTED', () => {
    // Create deeply nested object literal
    let expr = '{ val: 1 }';
    for (let i = 0; i < 20; i++) {
      expr = `{ next: ${expr} }`;
    }
    const src = `const deep = ${expr};`;
    const v: Vertex = { projectId: 'p1', fileId: 'src/deep.ts' };
    const sealedFs = createSealedFs([{ path: v.fileId, content: src }]);

    const producer = new FragmentAdmissionProducer(sealedFs);
    const cert = producer.produceAdmission(envRef, closureRef, [v]);

    // Set maxSyntaxNesting = 5
    const tightBudget = new VerificationBudget({
      ...INITIAL_RESOURCE_PROFILE,
      maxSyntaxNesting: 5
    });
    const verifier = new FragmentAdmissionVerifier(sealedFs, tightBudget);
    const res = verifier.verify(cert);

    assert.strictEqual(res.status, 'RESOURCE_EXHAUSTED');
    if (res.status === 'RESOURCE_EXHAUSTED') {
      assert.strictEqual(res.detail.resourceKind, 'SYNTAX_NESTING');
    }
  });
});
