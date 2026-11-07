import * as assert from 'node:assert/strict';
import * as ts from 'typescript';
import { proveCandidateBindingAbsent } from '../../src/sajimora/identity/CandidateDeletionProof';
import { TypeScriptCompatibility } from '../../src/sajimora/compatibility/TypeScriptCompatibility';
import type { CrossVersionIdentityBundle, CanonicalReferenceOccurrence, CanonicalSymbolIdentity } from '@sajimora/core';

const parent: CanonicalSymbolIdentity = {
  identityId: 'parent-id', projectId: 'project', moduleIdentity: 'api.ts', ownerChain: [],
  localName: 'oldTarget', declarationKind: 'FunctionDeclaration', declarationOrdinal: 0,
  sourceSpan: { start: 0, end: 30, line: 1, column: 1, endLine: 1, endColumn: 31 },
  exportPaths: [], parameterShape: '', astFingerprint: 'unmatched-parent-fingerprint'
};
const occ: CanonicalReferenceOccurrence = {
  occurrenceId: 'occ-1', sourceFile: 'api.ts', sourceSpan: { start: 32, end: 41, line: 2, column: 1 },
  syntaxKind: ts.SyntaxKind.Identifier, semanticRole: 'VALUE', usageRole: 'CALL_SITE',
  referencedSymbol: 'parent-id', declarationSymbol: 'parent-id', resolutionStatus: 'RESOLVED',
  enumerationStatus: 'COMPLETE', provenance: []
};
const bundle = (status: 'REMOVED_DECLARATION' | 'UNRESOLVED' | 'AMBIGUOUS', addedKind?: string): CrossVersionIdentityBundle => ({
  targetMappings: [
    { parent, status, evidence: [], plausibleCandidateIds: [] },
    ...(addedKind ? [{ candidate: { ...parent, identityId: 'replacement', localName: 'replacement', declarationKind: addedKind },
      status: 'ADDED_DECLARATION' as const, evidence: [], plausibleCandidateIds: [] }] : [])
  ], consumerMappings: [], status: 'COMPLETE', blockers: [],
  phaseOutcome: { verdict: 'UNKNOWN', reason: 'RELATION_ENGINE_NOT_IMPLEMENTED' },
  boundaryAudit: { compilerObjectsInArtifact: 0, crossProgramCompilerObjectComparisons: 0 }
});
const program = (source: string) => {
  const file = 'api.ts';
  const options: ts.CompilerOptions = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name, languageVersion) => name === file ? ts.createSourceFile(file, source, languageVersion) : undefined;
  host.fileExists = name => name === file;
  host.readFile = name => name === file ? source : undefined;
  return ts.createProgram([file], options, host);
};
const prove = (source: string, mapping = bundle('REMOVED_DECLARATION'), occurrence = occ, complete = true) =>
  proveCandidateBindingAbsent({ occurrence, persistentSymbolId: 'parent-id',
    bundle: complete ? mapping : { ...mapping, blockers: ['PROGRAM_DISCOVERY_INCOMPLETE'] },
    candidatePrograms: [program(source)], closureProvenance: ['ValueReferenceClosure'] });

assert.equal(prove('export const unrelated = 1;').status, 'PROVEN_ABSENT');
assert.equal(prove('export function oldTarget() {}').status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export function renamedTarget() {}', bundle('REMOVED_DECLARATION', 'FunctionDeclaration')).status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export function unrelatedReplacement() {}', bundle('UNRESOLVED')).status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export function oldTarget() {}', bundle('UNRESOLVED')).status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export function movedTarget() {}', bundle('REMOVED_DECLARATION', 'FunctionDeclaration')).status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export function oldTarget(x: string): string; export function oldTarget(x: any) { return x; }').status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export const unrelated = 1;', bundle('AMBIGUOUS')).status, 'AMBIGUOUS');
assert.equal(prove('export const unrelated = 1;', bundle('REMOVED_DECLARATION'), occ, false).status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export const unrelated = 1;', bundle('REMOVED_DECLARATION'), { ...occ, resolutionStatus: 'UNRESOLVED' }).status, 'IDENTITY_UNPROVEN');
assert.equal(prove('import { oldTarget } from "./missing"; export { oldTarget };').status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export * from "./missing";').status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export * from "./missing"; export { oldTarget } from "./missing";').status, 'IDENTITY_UNPROVEN');
assert.equal(prove('export * from "./other";').status, 'IDENTITY_UNPROVEN');
const proven = prove('export const unrelated = 1;');
assert.ok(proven.evidenceId && proven.proofHash && proven.parentBinding === 'parent-id');
assert.equal(proven.closureProvenance[0], 'ValueReferenceClosure');
const obligation = { mutatedSymbol: { symbolId: 'oldTarget', persistentSymbolId: 'parent-id' },
  providerMutation: { classification: 'SYMBOL_DELETED' } } as any;
const site = { usageSiteId: occ.occurrenceId,
  canonicalOccurrence: { ...occ, usageRole: 'TYPE_ANNOTATION' }, deletionProof: proven,
  evaluationStatus: 'EVALUABLE', identityResult: 'SAME' } as any;
const expectedType = { kind: 'PRIMITIVE', primitive: 'string', display: 'string', irContentHash: 'parent-type' };
const historical = { usageSiteId: occ.occurrenceId, occurrenceId: occ.occurrenceId,
  specializedContract: { schemaVersion: 'SAJIMORA_USAGE_CONTRACT_V1', languageId: 'typescript',
    usageRole: 'TYPE_ANNOTATION', expectedType, isDiscardedReturn: false,
    hasCompleteSpecializationEvidence: true, usageHash: 'usage' } };
const evaluateMissing = (candidate: object) => new TypeScriptCompatibility(undefined, obligation, {
  isPhase4Mode: true, provider: {
    getHistoricalObligation: () => historical,
    getCandidateContract: () => ({ targetSymbolId: 'parent-id', targetName: 'oldTarget', ...candidate })
  } as any
}).evaluateSite(site);
assert.equal(evaluateMissing({ blockerId: 'CANDIDATE_DECLARATION_MISSING' }).status, 'UNDECIDABLE');
assert.equal(evaluateMissing({ isDeleted: true, blockerId: 'CANDIDATE_DECLARATION_MISSING' }).status, 'UNDECIDABLE');
const deletionResult = evaluateMissing({ isDeleted: true });
assert.equal(deletionResult.status, 'INCOMPATIBLE');
assert.ok(deletionResult.phase4Evidence?.witness?.evidenceChain.includes(proven.evidenceId));
const missingProofSite = { ...site, deletionProof: undefined };
const withoutProof = new TypeScriptCompatibility(undefined, obligation, {
  isPhase4Mode: true, provider: {
    getHistoricalObligation: () => historical,
    getCandidateContract: () => ({ targetSymbolId: 'parent-id', targetName: 'oldTarget', isDeleted: true })
  } as any
}).evaluateSite(missingProofSite);
assert.equal(withoutProof.status, 'UNDECIDABLE');
console.log('CandidateDeletionProof.test.ts PASSED');
