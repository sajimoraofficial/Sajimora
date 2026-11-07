import { describe, it } from 'node:test';
import assert from 'node:assert';
import { F0RestrictedResolver } from '../../../../packages/analysis/src/sajimora/certified/closure/F0RestrictedResolver';
import { SealedFilesystem } from '../../../../packages/analysis/src/sajimora/certified/environment/SealedFilesystem';
import { VerificationBudget } from '../../../../packages/analysis/src/sajimora/certified/proof/VerificationBudget';
import { FileEntry, ResolutionFact, Vertex } from '../../../../packages/core/src/sajimora/certified/contracts';
import { CanonicalSet, computeDomainSeparatedHash } from '../../../../packages/core/src/sajimora/certified/canonicalEncoding';
import { ArtifactDomain, RootPolicyId, SAJIMORA_CERTIFIED_EVIDENCE_V1, INITIAL_RESOURCE_PROFILE, ResolverProfileId } from '../../../../packages/core/src/sajimora/certified/protocol';
import { BlockerCode } from '../../../../packages/core/src/sajimora/certified/blockers';
import { ASTAnchorExtractor } from '../../../../packages/analysis/src/sajimora/certified/closure/ASTExtractor';
import { DependencyClosureProducer } from '../../../../packages/analysis/src/sajimora/certified/closure/DependencyClosureProducer';
import { DependencyClosureVerifier } from '../../../../packages/analysis/src/sajimora/certified/closure/DependencyClosureVerifier';

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

describe('F0 Pure-Filesystem Package Subpath Resolution Suite', () => {

  // 1. Positive unscoped package subpaths
  it('resolves unscoped package subpath via extension probe (.ts, .tsx, .d.ts)', () => {
    const fs = createSealedFs([
      { path: 'src/app.ts', content: "import { helper } from 'my-pkg/utils/helper';" },
      { path: 'node_modules/my-pkg/package.json', content: JSON.stringify({ name: 'my-pkg', main: './index.js' }) },
      { path: 'node_modules/my-pkg/utils/helper.ts', content: 'export const helper = 1;' }
    ]);
    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const resolver = new F0RestrictedResolver(fs, budget);

    const res = resolver.resolve('my-pkg/utils/helper', 'src/app.ts');
    assert.strictEqual(res.outcome, 'RESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, 'node_modules/my-pkg/utils/helper.ts');
    assert.ok(res.metadataFileIds.includes('node_modules/my-pkg/package.json'));
  });

  it('resolves unscoped package subpath with exact file extension', () => {
    const fs = createSealedFs([
      { path: 'src/app.ts', content: "import { helper } from 'my-pkg/utils/helper.d.ts';" },
      { path: 'node_modules/my-pkg/package.json', content: JSON.stringify({ name: 'my-pkg' }) },
      { path: 'node_modules/my-pkg/utils/helper.d.ts', content: 'export declare const helper: number;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('my-pkg/utils/helper.d.ts', 'src/app.ts');
    assert.strictEqual(res.outcome, 'RESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, 'node_modules/my-pkg/utils/helper.d.ts');
  });

  it('resolves unscoped package subpath via subdirectory package.json', () => {
    const fs = createSealedFs([
      { path: 'src/app.ts', content: "import { sub } from 'my-pkg/sub';" },
      { path: 'node_modules/my-pkg/package.json', content: JSON.stringify({ name: 'my-pkg' }) },
      { path: 'node_modules/my-pkg/sub/package.json', content: JSON.stringify({ types: './custom.d.ts' }) },
      { path: 'node_modules/my-pkg/sub/custom.d.ts', content: 'export declare const sub: string;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('my-pkg/sub', 'src/app.ts');
    assert.strictEqual(res.outcome, 'RESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, 'node_modules/my-pkg/sub/custom.d.ts');
    assert.ok(res.metadataFileIds.includes('node_modules/my-pkg/sub/package.json'));
  });

  it('resolves unscoped package subpath via subdirectory index file', () => {
    const fs = createSealedFs([
      { path: 'src/app.ts', content: "import { fp } from 'lodash/fp';" },
      { path: 'node_modules/lodash/package.json', content: JSON.stringify({ name: 'lodash' }) },
      { path: 'node_modules/lodash/fp/index.d.ts', content: 'export declare const fp: any;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('lodash/fp', 'src/app.ts');
    assert.strictEqual(res.outcome, 'RESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, 'node_modules/lodash/fp/index.d.ts');
  });

  // 2. Positive scoped package subpaths
  it('resolves scoped package subpath via extension probe', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import * as fs from '@types/node/fs';" },
      { path: 'node_modules/@types/node/package.json', content: JSON.stringify({ name: '@types/node' }) },
      { path: 'node_modules/@types/node/fs.d.ts', content: 'export declare function read(): void;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('@types/node/fs', 'src/index.ts');
    assert.strictEqual(res.outcome, 'RESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, 'node_modules/@types/node/fs.d.ts');
  });

  it('resolves deeply nested scoped package subpath', () => {
    const fs = createSealedFs([
      { path: 'apps/web/src/index.ts', content: "import { Button } from '@repo/ui/components/buttons/primary';" },
      { path: 'node_modules/@repo/ui/package.json', content: JSON.stringify({ name: '@repo/ui' }) },
      { path: 'node_modules/@repo/ui/components/buttons/primary.tsx', content: 'export const Button = () => null;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('@repo/ui/components/buttons/primary', 'apps/web/src/index.ts');
    assert.strictEqual(res.outcome, 'RESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, 'node_modules/@repo/ui/components/buttons/primary.tsx');
  });

  // 3. Negative resolution forms
  it('returns UNRESOLVED for uninstalled external package subpath', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { source } from 'fumadocs-core/source';" }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('fumadocs-core/source', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNRESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, null);
    assert.ok(res.orderedProbes.length > 0);
    assert.ok(res.orderedProbes.every(p => !p.exists));
  });

  it('returns UNRESOLVED when subpath is missing in installed package without falling back to parent node_modules', () => {
    const fs = createSealedFs([
      { path: 'packages/app/src/index.ts', content: "import { missing } from 'pkg/missing';" },
      { path: 'packages/app/node_modules/pkg/package.json', content: JSON.stringify({ name: 'pkg' }) },
      { path: 'node_modules/pkg/package.json', content: JSON.stringify({ name: 'pkg' }) },
      { path: 'node_modules/pkg/missing.ts', content: 'export const missing = 2;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('pkg/missing', 'packages/app/src/index.ts');
    assert.strictEqual(res.outcome, 'UNRESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, null);
  });

  // 4. Security & Traversal Boundary Containment
  it('rejects path traversal escaping out of package root with UNSUPPORTED_CONFIGURATION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { secret } from 'pkg/../../secret';" },
      { path: 'secret.ts', content: 'export const secret = 42;' },
      { path: 'node_modules/pkg/package.json', content: JSON.stringify({ name: 'pkg' }) }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('pkg/../../secret', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNSUPPORTED');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
    assert.ok(res.blockerMessage?.includes('escapes package root'));
  });

  it('rejects scoped path traversal escaping with UNSUPPORTED_CONFIGURATION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { secret } from '@scope/pkg/../../../secret';" },
      { path: 'node_modules/@scope/pkg/package.json', content: JSON.stringify({ name: '@scope/pkg' }) }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('@scope/pkg/../../../secret', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNSUPPORTED');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
    assert.ok(res.blockerMessage?.includes('escapes package root'));
  });

  it('rejects invalid subpath formats with trailing slash or empty segments', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: 'export const x = 1;' },
      { path: 'node_modules/pkg/package.json', content: JSON.stringify({ name: 'pkg' }) }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const resTrailing = resolver.resolve('pkg/sub/', 'src/index.ts');
    assert.strictEqual(resTrailing.outcome, 'UNSUPPORTED');
    assert.strictEqual(resTrailing.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);

    const resEmpty = resolver.resolve('pkg//sub', 'src/index.ts');
    assert.strictEqual(resEmpty.outcome, 'UNSUPPORTED');
    assert.strictEqual(resEmpty.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
  });

  it('rejects malformed scoped package specifier with UNSUPPORTED_CONFIGURATION', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: 'export const x = 1;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('@scope', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNSUPPORTED');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
    assert.ok(res.blockerMessage?.includes('Malformed scoped package'));
  });

  // 5. Metadata Exclusions
  it('rejects package subpath when root package.json declares exports', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { sub } from 'pkg/sub';" },
      { path: 'node_modules/pkg/package.json', content: JSON.stringify({ name: 'pkg', exports: { './sub': './dist/sub.js' } }) },
      { path: 'node_modules/pkg/sub.ts', content: 'export const sub = 1;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('pkg/sub', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNSUPPORTED');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
    assert.ok(res.blockerMessage?.includes('Conditional exports unsupported'));
  });

  it('rejects package subpath when root package.json declares typesVersions', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { sub } from 'pkg/sub';" },
      { path: 'node_modules/pkg/package.json', content: JSON.stringify({ name: 'pkg', typesVersions: { '>=4.0': { '*': ['dist/*'] } } }) }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('pkg/sub', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNSUPPORTED');
    assert.strictEqual(res.blockerCode, BlockerCode.UNSUPPORTED_CONFIGURATION);
    assert.ok(res.blockerMessage?.includes('typesVersions unsupported'));
  });

  it('fails closed when subdirectory package.json types field fails to resolve (no fallback to typings or main)', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { sub } from 'pkg/sub';" },
      { path: 'node_modules/pkg/package.json', content: JSON.stringify({ name: 'pkg' }) },
      { path: 'node_modules/pkg/sub/package.json', content: JSON.stringify({ types: './missing.d.ts', main: './exists.ts' }) },
      { path: 'node_modules/pkg/sub/exists.ts', content: 'export const sub = 1;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);

    const res = resolver.resolve('pkg/sub', 'src/index.ts');
    assert.strictEqual(res.outcome, 'UNRESOLVED');
    assert.strictEqual(res.selectedTargetOrNull, null);
  });

  // 6. Replay Equivalence & verifyFact()
  it('strictly verifies a sound RESOLVED package subpath ResolutionFact', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { foo } from 'pkg/utils/foo';" },
      { path: 'node_modules/pkg/package.json', content: JSON.stringify({ name: 'pkg' }) },
      { path: 'node_modules/pkg/utils/foo.ts', content: 'export const foo = 42;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);
    const res = resolver.resolve('pkg/utils/foo', 'src/index.ts');

    const fact: ResolutionFact = {
      request: {
        _opaqueF0Semantics: 'UNRESOLVED',
        payload: {
          specifier: 'pkg/utils/foo',
          containingFile: 'src/index.ts',
          compilerOptions: null
        }
      },
      resolverProfileId: ResolverProfileId.F0_NODE10_STATIC_V1,
      orderedProbes: res.orderedProbes,
      metadataFileIds: res.metadataFileIds,
      selectedTargetOrNull: res.selectedTargetOrNull,
      outcome: res.outcome
    };

    const verifyRes = resolver.verifyFact(fact);
    assert.strictEqual(verifyRes.status, 'VERIFIED');
  });

  it('strictly verifies a sound UNRESOLVED external package subpath ResolutionFact', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { foo } from 'external-pkg/sub';" }
    ]);
    const resolver = new F0RestrictedResolver(fs);
    const res = resolver.resolve('external-pkg/sub', 'src/index.ts');

    const fact: ResolutionFact = {
      request: {
        _opaqueF0Semantics: 'UNRESOLVED',
        payload: {
          specifier: 'external-pkg/sub',
          containingFile: 'src/index.ts',
          compilerOptions: null
        }
      },
      resolverProfileId: ResolverProfileId.F0_NODE10_STATIC_V1,
      orderedProbes: res.orderedProbes,
      metadataFileIds: res.metadataFileIds,
      selectedTargetOrNull: res.selectedTargetOrNull,
      outcome: res.outcome
    };

    const verifyRes = resolver.verifyFact(fact);
    assert.strictEqual(verifyRes.status, 'VERIFIED');
  });

  it('rejects tampered ResolutionFact probe sequence with HASH_MISMATCH', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { foo } from 'pkg/foo';" },
      { path: 'node_modules/pkg/package.json', content: JSON.stringify({ name: 'pkg' }) },
      { path: 'node_modules/pkg/foo.ts', content: 'export const foo = 1;' }
    ]);
    const resolver = new F0RestrictedResolver(fs);
    const res = resolver.resolve('pkg/foo', 'src/index.ts');

    const tamperedFact: ResolutionFact = {
      request: {
        _opaqueF0Semantics: 'UNRESOLVED',
        payload: {
          specifier: 'pkg/foo',
          containingFile: 'src/index.ts',
          compilerOptions: null
        }
      },
      resolverProfileId: ResolverProfileId.F0_NODE10_STATIC_V1,
      orderedProbes: res.orderedProbes.slice(0, 1),
      metadataFileIds: res.metadataFileIds,
      selectedTargetOrNull: res.selectedTargetOrNull,
      outcome: res.outcome
    };

    const verifyRes = resolver.verifyFact(tamperedFact);
    assert.strictEqual(verifyRes.status, 'REJECTED');
    if (verifyRes.status === 'REJECTED') {
      assert.strictEqual(verifyRes.blockerCode, BlockerCode.HASH_MISMATCH);
    }
  });

  // 7. Full Dependency Closure Fixed Point with Package Subpaths
  it('successfully completes DependencyClosureVerifier with package subpaths in reachedVertices', () => {
    const fs = createSealedFs([
      { path: 'src/index.ts', content: "import { util } from 'my-lib/core/util';\nutil();" },
      { path: 'node_modules/my-lib/package.json', content: JSON.stringify({ name: 'my-lib' }) },
      { path: 'node_modules/my-lib/core/util.ts', content: "export function util() { return 10; }" }
    ]);

    const extractor = new ASTAnchorExtractor();
    const resolver = new F0RestrictedResolver(fs);
    const producer = new DependencyClosureProducer(fs, extractor, resolver);

    const manifestDigest = 'd'.repeat(64);
    const rootVertices = new CanonicalSet<Vertex>([{ projectId: 'proj', fileId: 'src/index.ts' }]);

    const cert = producer.produceClosure(
      { domain: ArtifactDomain.MANIFEST, digest: manifestDigest },
      RootPolicyId.F0_ENV_GIT_SEALED_V1,
      rootVertices
    );

    const reachedFiles = Array.from(cert.reachedVertices).map(v => v.fileId);
    assert.ok(reachedFiles.includes('src/index.ts'));
    assert.ok(reachedFiles.includes('node_modules/my-lib/core/util.ts'));

    const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
    const verifier = new DependencyClosureVerifier(fs, extractor, resolver, budget);

    const result = verifier.verify(cert, {
      facts: cert.facts,
      edges: cert.edges,
      discharges: cert.discharges
    });

    assert.strictEqual(result.status, 'VERIFIED');
    if (result.status === 'VERIFIED') {
      assert.strictEqual(result.verifiedClaim, 'CLOSURE_COMPLETED');
    }
  });
});
