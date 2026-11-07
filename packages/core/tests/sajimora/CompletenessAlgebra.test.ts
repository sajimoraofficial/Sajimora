import {
  meetCompleteness,
  meetAllCompleteness,
  combineResolutionStatus,
  enforceAmbiguityPoisoning,
  normalizeModuleIdentity,
  computeDeclarationSetIdentity
} from '../../src/sajimora/algebra/completeness';
import { isProviderMutationValidlyCharacterized } from '../../src/sajimora/types/mutation';
import { ClosureEvidence, isSourceInUniverse, RepositoryAnalysisUniverse } from '../../src/sajimora/types/closure';
import { DeclarationAnchor } from '../../src/sajimora/types/usage';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('Testing Completeness Algebra...');

function membershipUniverse(entries: string[]): RepositoryAnalysisUniverse {
  return {
    rootPath: 'E:/repo',
    discoveredFiles: entries,
    discoveredFileSet: new Set(entries),
    excludedFiles: new Map(),
    unsupportedFiles: [],
    unreadableFiles: [],
    parseFailures: new Map(),
    discoveryStatus: 'DISCOVERY_COMPLETE',
    discoveryEvidence: 'membership test'
  };
}

// Membership uses exact normalized membership first, then preserves the
// existing case-insensitive behavior.  The companion index must also follow
// normal Set mutations used by fail-closed universe handling.
const membership = membershipUniverse(['E:/Repo/Provider.ts']);
assert(isSourceInUniverse(membership, 'e:/repo/provider.ts'), 'Case-insensitive membership is preserved');
membership.discoveredFileSet.delete('E:/Repo/Provider.ts');
assert(!isSourceInUniverse(membership, 'e:/repo/provider.ts'), 'Deletion invalidates case-insensitive membership');
membership.discoveredFileSet.add('E:/Repo/Consumer.ts');
assert(isSourceInUniverse(membership, 'e:/repo/consumer.ts'), 'Addition updates case-insensitive membership');
membership.discoveredFileSet.clear();
assert(!isSourceInUniverse(membership, 'e:/repo/consumer.ts'), 'Clear invalidates case-insensitive membership');

// 1. Meet Semilattice Properties
assert(meetCompleteness('COMPLETE', 'COMPLETE') === 'COMPLETE', 'COMPLETE ^ COMPLETE = COMPLETE');
assert(meetCompleteness('COMPLETE', 'INCOMPLETE') === 'INCOMPLETE', 'COMPLETE ^ INCOMPLETE = INCOMPLETE');
assert(meetCompleteness('INCOMPLETE', 'COMPLETE') === 'INCOMPLETE', 'INCOMPLETE ^ COMPLETE = INCOMPLETE');
assert(meetCompleteness('INCOMPLETE', 'INCOMPLETE') === 'INCOMPLETE', 'INCOMPLETE ^ INCOMPLETE = INCOMPLETE');
assert(meetCompleteness('COMPLETE', 'FAILED') === 'FAILED', 'COMPLETE ^ FAILED = FAILED');
assert(meetCompleteness('INCOMPLETE', 'FAILED') === 'FAILED', 'INCOMPLETE ^ FAILED = FAILED');
assert(meetCompleteness('FAILED', 'COMPLETE') === 'FAILED', 'FAILED ^ COMPLETE = FAILED');
assert(meetCompleteness('FAILED', 'INCOMPLETE') === 'FAILED', 'FAILED ^ INCOMPLETE = FAILED');
assert(meetCompleteness('FAILED', 'FAILED') === 'FAILED', 'FAILED ^ FAILED = FAILED');

// Multi-way meet
assert(meetAllCompleteness([]) === 'INCOMPLETE', 'meetAll empty yields INCOMPLETE');
assert(meetAllCompleteness(['COMPLETE', 'COMPLETE', 'COMPLETE']) === 'COMPLETE', 'meetAll COMPLETE');
assert(meetAllCompleteness(['COMPLETE', 'INCOMPLETE', 'COMPLETE']) === 'INCOMPLETE', 'meetAll INCOMPLETE');
assert(meetAllCompleteness(['COMPLETE', 'INCOMPLETE', 'FAILED']) === 'FAILED', 'meetAll FAILED');

// 2. Conservative Resolution Aggregation Policy
assert(combineResolutionStatus(['RESOLVED', 'RESOLVED']) === 'RESOLVED', 'RESOLVED');
assert(combineResolutionStatus(['RESOLVED', 'AMBIGUOUS']) === 'AMBIGUOUS', 'AMBIGUOUS dominates RESOLVED');
assert(combineResolutionStatus(['RESOLVED', 'CYCLIC']) === 'CYCLIC', 'CYCLIC dominates RESOLVED');
assert(combineResolutionStatus(['CYCLIC', 'AMBIGUOUS']) === 'AMBIGUOUS', 'AMBIGUOUS dominates CYCLIC');
assert(combineResolutionStatus(['AMBIGUOUS', 'UNDECIDABLE']) === 'UNDECIDABLE', 'UNDECIDABLE dominates AMBIGUOUS');

// 3. Ambiguity Poisoning
const cleanEvidence: ClosureEvidence = {
  closureName: 'ValueReferenceClosure',
  occurrences: [
    {
      occurrenceId: 'occ-1',
      sourceFile: 'packages/core/src/test.ts',
      sourceSpan: { start: 0, end: 5, line: 1, column: 1 },
      syntaxKind: 79,
      semanticRole: 'VALUE',
      usageRole: 'CALL_SITE',
      referencedSymbol: 'sym-1',
      declarationSymbol: 'decl-1',
      resolutionStatus: 'RESOLVED',
      enumerationStatus: 'COMPLETE',
      provenance: []
    }
  ],
  completeness: 'COMPLETE',
  failures: [],
  ambiguities: [],
  unrecognizedForms: [],
  provenance: []
};

const cleanPoisoned = enforceAmbiguityPoisoning(cleanEvidence);
assert(cleanPoisoned.completeness === 'COMPLETE', 'Clean evidence remains COMPLETE');

const ambiguousEvidence: ClosureEvidence = {
  ...cleanEvidence,
  occurrences: [
    ...cleanEvidence.occurrences,
    {
      ...cleanEvidence.occurrences[0],
      occurrenceId: 'occ-2',
      resolutionStatus: 'AMBIGUOUS'
    }
  ]
};

const poisoned = enforceAmbiguityPoisoning(ambiguousEvidence);
assert(poisoned.completeness === 'INCOMPLETE', 'Ambiguous occurrence poisons completeness to INCOMPLETE');
assert(poisoned.failures.length === 1, 'Failure recorded for poisoning');

// 4. Module Identity Normalization (Injective)
assert(
  normalizeModuleIdentity('E:/repo/packages/core/src/auth.ts', 'E:/repo') === 'packages/core/src/auth.ts',
  'Normalizes module identity preserving extension'
);
assert(
  normalizeModuleIdentity('E:\\repo\\packages\\core\\src\\auth.tsx', 'E:\\repo') === 'packages/core/src/auth.tsx',
  'Normalizes backslashes to forward slashes'
);

// 5. Deterministic Declaration Set Identity
const anchorA: DeclarationAnchor = {
  moduleIdentity: 'packages/core/src/auth.ts',
  symbolLocalName: 'AuthService',
  kind: 'interface',
  parameterTypeFingerprint: '',
  declarationOrdinal: 1,
  syntaxKind: 261
};

const anchorB: DeclarationAnchor = {
  moduleIdentity: 'packages/core/src/auth.ts',
  symbolLocalName: 'AuthService',
  kind: 'namespace',
  parameterTypeFingerprint: '',
  declarationOrdinal: 0,
  syntaxKind: 264
};

// Shuffled anchors must produce identical declarationSymbol
const id1 = computeDeclarationSetIdentity([anchorA, anchorB]);
const id2 = computeDeclarationSetIdentity([anchorB, anchorA]);
assert(id1 === id2, 'Anchor order independence for merged declarations');

// 6. Provider Mutation Valid Characterization
assert(
  isProviderMutationValidlyCharacterized({
    targetSymbolId: 'sym-1',
    beforeExists: true,
    afterExists: true,
    classification: 'EXPORTED_SIGNATURE_MUTATED',
    isAstDiffDerived: true,
    beforeParsed: true,
    afterParsed: true
  }),
  'Validly characterized mutation passes'
);

assert(
  !isProviderMutationValidlyCharacterized({
    targetSymbolId: 'sym-1',
    beforeExists: false,
    afterExists: true,
    classification: 'EXPORTED_SIGNATURE_MUTATED',
    isAstDiffDerived: true,
    beforeParsed: true,
    afterParsed: true
  }),
  'Invalid beforeExists fails'
);

console.log('All Completeness Algebra tests passed successfully!');
