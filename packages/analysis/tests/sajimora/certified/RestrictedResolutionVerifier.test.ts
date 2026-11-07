import { RestrictedResolutionVerifier } from '../../../src/sajimora/certified/environment/RestrictedResolutionVerifier';
import { SealedFilesystem } from '../../../src/sajimora/certified/environment/SealedFilesystem';
import { VerificationBudget } from '../../../src/sajimora/certified/proof/VerificationBudget';
import { INITIAL_RESOURCE_PROFILE, ResolverProfileId, ArtifactDomain } from '../../../../core/src/sajimora/certified/protocol';
import { ResolutionFact } from '../../../../core/src/sajimora/certified/contracts';
import { BlockerCode } from '../../../../core/src/sajimora/certified/blockers';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

console.log('Testing RestrictedResolutionVerifier...');

const getSealedFs = (files: string[]) => {
  return new SealedFilesystem(
    files.map(f => ({
      fileId: f,
      logicalPath: f,
      byteLength: 0,
      bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: 'dummy' },
      mode: 0,
      kind: 'SOURCE',
      origin: 'GIT_OBJECT',
      provenanceRefs: []
    })),
    [{ digest: 'dummy', data: Buffer.from('') }],
    'CASE_SENSITIVE'
  );
};

// 1. structural validation succeeds, but semantics block VERIFIED because opaque payload
{
  const fs = getSealedFs(['src/index.ts']);
  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
  const verifier = new RestrictedResolutionVerifier(fs, budget);

  const fact: ResolutionFact = {
    request: { _opaqueF0Semantics: 'UNRESOLVED', payload: {} } as any,
    resolverProfileId: ResolverProfileId.F0_NODE10_STATIC_V1,
    orderedProbes: [
      { logicalPath: 'src/index.js', exists: false },
      { logicalPath: 'src/index.ts', exists: true }
    ],
    metadataFileIds: [],
    selectedTargetOrNull: 'src/index.ts',
    outcome: 'RESOLVED'
  };

  const result = verifier.verifyFact(fact);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.UNSUPPORTED_CONFIGURATION, 'Should structurally validate but block due to opaque resolution semantics');
}

// 2. rejects forged exists:false
{
  const fs = getSealedFs(['src/index.ts']); // sealed fs says it exists
  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
  const verifier = new RestrictedResolutionVerifier(fs, budget);

  const fact: ResolutionFact = {
    request: { _opaqueF0Semantics: 'UNRESOLVED', payload: {} } as any,
    resolverProfileId: ResolverProfileId.F0_NODE10_STATIC_V1,
    orderedProbes: [
      { logicalPath: 'src/index.ts', exists: false } // hostile lie
    ],
    metadataFileIds: [],
    selectedTargetOrNull: 'src/index.ts',
    outcome: 'RESOLVED'
  };

  const result = verifier.verifyFact(fact);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.MISSING_EVIDENCE, 'Should reject hostile exists:false forgery during structural validation');
}

// 3. rejects absolute symlink escape to an OS path (structural traversal validation)
{
  const fs = getSealedFs(['src/index.ts']);
  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
  const verifier = new RestrictedResolutionVerifier(fs, budget);

  const fact: ResolutionFact = {
    request: { _opaqueF0Semantics: 'UNRESOLVED', payload: {} } as any,
    resolverProfileId: ResolverProfileId.F0_NODE10_STATIC_V1,
    orderedProbes: [
      { logicalPath: '/etc/passwd', exists: true } // Malicious absolute OS path
    ],
    metadataFileIds: [],
    selectedTargetOrNull: '/etc/passwd',
    outcome: 'RESOLVED'
  };

  const result = verifier.verifyFact(fact);
  // SealedFS doesn't throw on lookup, it just returns false for `exists()`.
  // Wait, if it returns false, and the probe says `exists: true`, it rejects with MISSING_EVIDENCE.
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.MISSING_EVIDENCE, 'Should reject absolute path escape');
}

// 4. rejects unsupported resolver profiles
{
  const fs = getSealedFs(['src/index.ts']);
  const budget = new VerificationBudget(INITIAL_RESOURCE_PROFILE);
  const verifier = new RestrictedResolutionVerifier(fs, budget);

  const fact: ResolutionFact = {
    request: { _opaqueF0Semantics: 'UNRESOLVED', payload: {} } as any,
    resolverProfileId: 'UNSUPPORTED_PROFILE',
    orderedProbes: [],
    metadataFileIds: [],
    selectedTargetOrNull: null,
    outcome: 'UNSUPPORTED'
  };

  const result = verifier.verifyFact(fact);
  assert(result.status === 'REJECTED' && result.blockerCode === BlockerCode.UNSUPPORTED_CONFIGURATION, 'Should reject unsupported profile');
}

console.log('RestrictedResolutionVerifier tests passed.');
