/** Source-bound operational regression suite. Unsupported equivalence is UNKNOWN. */
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EvidenceAcceptanceSession, GenericRepository, GenericRepositorySnapshot, VerificationObligation, ConservationGate } from '@sajimora/core';
import { TypeScriptProductionAdapter } from '../../src/sajimora/languages/typescript/production/TypeScriptProductionAdapter';
import { TypeScriptNumericWitnessChecker } from '../../src/sajimora/languages/typescript/production/TypeScriptNumericWitnessChecker';

function snapshot(snapshotId: string, source: string): GenericRepositorySnapshot {
  return { snapshotId, rootIdentifier: '/', files: [{ path: 'calc.ts', byteLength: Buffer.byteLength(source), hash: createHash('sha256').update(source).digest('hex') }],
    readTextFile: p => p === 'calc.ts' ? source : undefined, readBinaryFile: p => p === 'calc.ts' ? Buffer.from(source) : undefined };
}
const fixtures = [
  ['alpha-renaming with local variables', 'const y = x; return y + 1;', 'const z = x; return z + 1;', 'UNKNOWN'],
  ['variable capture', 'const outer = 10; return x + outer;', 'const outer = 10; return outer + outer;', 'UNKNOWN'],
  ['object key rename', 'return { x };', 'return { y: x };', 'UNKNOWN'],
  ['unchanged external dependency', 'return dependency(x);', 'return dependency(x);', 'UNKNOWN'],
  ['caught throw', 'return x;', 'try { throw x; } catch(e) { return e; }', 'UNKNOWN'],
  ['finally overrides return', 'return 1;', 'try { return 2; } finally { return 1; }', 'UNKNOWN'],
  ['throw after return', 'return x;', 'return x; throw new Error();', 'UNKNOWN'],
  ['throw before return', 'return x;', 'throw new Error(); return x;', 'UNKNOWN'],
  ['signed zero observable through division', 'return 1 / x;', 'return -1 / x;', 'VIOLATED'],
  ['comment-only fake arithmetic', 'return x; // x * 2', 'return x; // x * 200', 'UNKNOWN'],
  ['string arithmetic', 'return "x * 2";', 'return "x * 200";', 'UNKNOWN'],
  ['floating-point reassociation', 'return (x + 1) + 2;', 'return x + 3;', 'VIOLATED'],
  ['unproved arithmetic equivalence', 'return x * 2;', 'return x + x;', 'UNKNOWN'],
  ['general loop', 'return x;', 'while (x > 0) { x--; } return x;', 'UNKNOWN'],
  ['supported numeric counterexample', 'return x * 2;', 'return x * 200;', 'VIOLATED']
] as const;

export async function runPhase7OperationalBehaviorTests(): Promise<void> {
  const adapter = new TypeScriptProductionAdapter();
  for (const [name, before, after, expected] of fixtures) {
    const repo: GenericRepository = { repositoryId: 'phase7', parentSnapshot: snapshot('parent', 'export function compute(x: number) { ' + before + '\n}'),
      candidateSnapshot: snapshot('candidate', 'export function compute(x: number) { ' + after + '\n}') };
    const entity = (entityId: string) => ({ entityId, projectId: 'project', name: 'compute', qualifiedName: 'compute', kind: 'FUNCTION' as const,
      filePath: 'calc.ts', signatureFingerprint: '(number)=>number', isExported: true });
    const ob: VerificationObligation = { obligationId: name, projectId: 'project', question: 'BEHAVIORAL_COMPATIBILITY', scope: 'PROVIDER', createdAt: '',
      change: { changeId: name, changeKind: 'BODY_MUTATED', description: name, identity: { identityId: name, status: 'CONFIRMED_IDENTITY', confidence: 'CERTAIN',
        parentEntity: entity('parent-fn'), candidateEntity: entity('candidate-fn') } } };
    const verdict = await adapter.evaluateObligation(ob, repo);
    assert.equal(verdict.outcome, expected, name);
    const acceptance = new EvidenceAcceptanceSession(repo, [new TypeScriptNumericWitnessChecker()]);
    if (expected === 'VIOLATED') {
      assert.equal(verdict.assurance, 'WITNESS', name);
      assert.equal(acceptance.verifyAndAccept(ob, verdict), true, name);
    } else {
      assert.equal(verdict.assurance, 'UNRESOLVED', name);
    }
    assert.equal(ConservationGate.reconcileAndEnforce([], [ob], [verdict], acceptance).conservationSatisfied, true);
  }
  console.log('Phase 7: ' + fixtures.length + ' source-backed behavior admission and counterexample regressions passed.');
}
runPhase7OperationalBehaviorTests().catch(error => { console.error(error); process.exitCode = 1; });
