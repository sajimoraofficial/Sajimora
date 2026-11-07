import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { CertifiedCampaignAdapter, PilotSourceFile } from '../../../../../scripts/campaign/CertifiedCampaignAdapter';
import { CertifiedCorrespondence } from '../../../src/sajimora/certified/identity/CertifiedCorrespondence';
import { HistoricalObligationGenerator } from '../../../src/sajimora/certified/obligations/HistoricalObligationGenerator';
import { CoverageProducer } from '../../../src/sajimora/certified/coverage/CoverageProducer';
import { ProofProducer } from '../../../src/sajimora/certified/proof/ProofProducer';
import { ArtifactDomain } from '../../../../core/src/sajimora/certified/protocol';
import { CanonicalSet } from '../../../../core/src/sajimora/certified/canonicalEncoding';

const provider = (value: number) => `export function calc(): number { return ${value}; }\n`;
const id = crypto.createHash('sha256').update('p0|provider.ts||FunctionDeclaration|calc|0').digest('hex');
const identityRef = { domain: ArtifactDomain.IDENTITY, digest: 'a'.repeat(64) };

function scenario(consumer: string, extras: PilotSourceFile[] = []) {
  const parentFiles = [{ path: 'consumer.ts', content: consumer }, { path: 'provider.ts', content: provider(1) }, ...extras];
  const candidateFiles = [{ path: 'consumer.ts', content: consumer }, { path: 'provider.ts', content: provider(2) }, ...extras];
  const parent = CertifiedCampaignAdapter.createVirtualEnvironment(parentFiles, 'parent');
  const candidate = CertifiedCampaignAdapter.createVirtualEnvironment(candidateFiles, 'candidate');
  const correspondence = CertifiedCorrespondence.produce(parent.manifest, candidate.manifest,
    parent.sealedFs, candidate.sealedFs, 'provider.ts', id);
  assert.ok(correspondence);
  const generate = (record = correspondence) => HistoricalObligationGenerator.generateObligations(
    parent.manifest, candidate.manifest, parent.sealedFs, candidate.sealedFs,
    'calc', identityRef, identityRef, record);
  return { parent, candidate, correspondence, generate };
}

test('named import resolves exact changed provider and keeps 0/0 sealed witness and anchor', () => {
  const s = scenario('import { calc } from "./provider";\nconst result: number = calc();\n');
  const { obligations } = s.generate();
  assert.equal(obligations.length, 1);
  const obl = obligations[0];
  assert.deepEqual([obl.historicalOccurrenceAnchor.fileId, obl.historicalOccurrenceAnchor.utf16Start,
    obl.historicalOccurrenceAnchor.utf16End], ['consumer.ts', 58, 64]);
  const relations = Array.from(obl.requiredRelations);
  assert.deepEqual(relations.map(r => r.kind), ['ARITY', 'RETURN_SATISFIES_CONTEXT']);
  assert.deepEqual(relations[0].sourceTermValueOrNull, { argCount: 0 });
  assert.deepEqual(relations[0].targetTermValueOrNull, { requiredParamCount: 0 });
  assert.deepEqual(relations[1].sourceTermValueOrNull, { kind: 'primitive', name: 'number' });
  assert.deepEqual(relations[1].targetTermValueOrNull, { kind: 'primitive', name: 'number' });
  const proof = ProofProducer.produceProof(obl);
  const arityBinding = proof.relationBindings?.find(r => r.relationId === 'ARITY_CHECK');
  assert.deepEqual(arityBinding?.sourceTermValueOrNull, { argCount: 0 });
  assert.deepEqual(arityBinding?.targetTermValueOrNull, { requiredParamCount: 0 });
  const coverage = CoverageProducer.produceCoverage(s.parent.manifest, s.candidate.manifest,
    s.parent.sealedFs, 'calc', identityRef, new CanonicalSet(), obligations);
  const covered = Array.from(coverage.contextDispositionLedger).find(x => x.disposition === 'COVERED');
  assert.deepEqual(covered?.contextAnchor, obl.historicalOccurrenceAnchor);
});

test('direct local call and aliased named import resolve', () => {
  const localParent = CertifiedCampaignAdapter.createVirtualEnvironment([
    { path: 'provider.ts', content: provider(1) + 'const result: number = calc();\n' }], 'parent');
  const localCandidate = CertifiedCampaignAdapter.createVirtualEnvironment([
    { path: 'provider.ts', content: provider(2) + 'const result: number = calc();\n' }], 'candidate');
  const localRecord = CertifiedCorrespondence.produce(localParent.manifest, localCandidate.manifest,
    localParent.sealedFs, localCandidate.sealedFs, 'provider.ts', id);
  assert.ok(localRecord);
  const direct = HistoricalObligationGenerator.generateObligations(localParent.manifest,
    localCandidate.manifest, localParent.sealedFs, localCandidate.sealedFs, 'calc',
    identityRef, identityRef, localRecord);
  assert.equal(direct.obligations.length, 1);
  const alias = scenario('import { calc as c } from "./provider";\nconst result: number = c();\n');
  assert.equal(alias.generate().obligations.length, 1);
});

test('same export name in another module cannot impersonate correspondence provider', () => {
  const extra = [{ path: 'other.ts', content: 'export function calc(): number { return 9; }\n' }];
  const good = scenario('import { calc } from "./provider";\nconst result: number = calc();\n', extra);
  assert.equal(good.generate().obligations.length, 1);
  const wrong = scenario('import { calc } from "./other";\nconst result: number = calc();\n', extra);
  assert.equal(wrong.generate().obligations.length, 0);
});

test('missing export, ambiguous local binding, and absent correspondence fail closed', () => {
  const missing = scenario('import { calc } from "./empty";\nconst result: number = calc();\n',
    [{ path: 'empty.ts', content: 'export const value = 1;\n' }]);
  assert.equal(missing.generate().obligations.length, 0);
  const ambiguous = scenario('import { calc } from "./provider";\nconst calc = 1;\nconst result: number = calc();\n');
  assert.equal(ambiguous.generate().obligations.length, 0);
  const valid = scenario('import { calc } from "./provider";\nconst result: number = calc();\n');
  assert.equal(valid.generate(undefined).obligations.length, 1);
  const noRecord = HistoricalObligationGenerator.generateObligations(valid.parent.manifest,
    valid.candidate.manifest, valid.parent.sealedFs, valid.candidate.sealedFs, 'calc',
    identityRef, identityRef);
  assert.equal(noRecord.obligations.length, 0);
});
