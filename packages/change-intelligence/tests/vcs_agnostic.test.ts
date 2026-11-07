/**
 * Test Suite 12: VCS-Agnostic Core Architecture & Provider Substitution
 * Verifies Test Requirements from Section 8:
 * - Test 2: Core does not directly depend on Git (Static isolation)
 * - Test 3: Provider substitution (InMemory / Non-Git VCS Provider)
 * - Test 5: Determinism across repeated evaluations
 */

import * as assert from 'assert';
import {
  AstStructuralDiffEngine,
  ChangeEvidenceLedgerService,
  ChangedFile,
  EcmBuilder,
  IRepositoryStateProvider,
  LazyBeforeStateProvider,
  RepositoryFilterOptions,
} from '../src';

console.log('--- Running VCS-Agnostic Core Architecture & Provider Substitution Tests ---');

// 1. Define an In-Memory / Non-Git Version Control Provider (e.g. simulating SVN / Snapshot)
class InMemoryVCSProvider implements IRepositoryStateProvider {
  readonly providerKind = 'in-memory-svn-mock';

  private revisions: Map<string, Map<string, string>> = new Map();
  private changeSets: Map<string, ChangedFile[]> = new Map();

  setRevisionFile(revision: string, filePath: string, content: string): void {
    if (!this.revisions.has(revision)) {
      this.revisions.set(revision, new Map());
    }
    this.revisions.get(revision)!.set(filePath, content);
  }

  setChangeSet(baseRev: string, candRev: string, files: ChangedFile[]): void {
    this.changeSets.set(`${baseRev}..${candRev}`, files);
  }

  async getActualChangeSet(
    baseRevision: string,
    candidateRevision: string,
    _options?: RepositoryFilterOptions
  ): Promise<ChangedFile[]> {
    const key = `${baseRevision}..${candidateRevision}`;
    return this.changeSets.get(key) || [];
  }

  async getFileContentAtRevision(
    revision: string,
    filePath: string
  ): Promise<string | null> {
    const revMap = this.revisions.get(revision);
    if (!revMap || !revMap.has(filePath)) return null;
    return revMap.get(filePath)!;
  }

  async getCandidateFileContent(
    revision: string,
    filePath: string
  ): Promise<string | null> {
    return this.getFileContentAtRevision(revision, filePath);
  }
}

async function runTests() {
  const vcs = new InMemoryVCSProvider();

  // Setup non-Git revision identities (e.g. SVN revisions r1001 and r1002)
  const baseRev = 'r1001';
  const candRev = 'r1002';
  const workspaceId = 'ws-svn-tenant';

  // Populate historical (BEFORE) state
  vcs.setRevisionFile(
    baseRev,
    'src/auth/service.ts',
    [
      'export class AuthService {',
      '  login(user: string, pass: string): boolean {',
      '    return true;',
      '  }',
      '}',
    ].join('\n')
  );

  // Populate candidate (AFTER) state
  vcs.setRevisionFile(
    candRev,
    'src/auth/service.ts',
    [
      'export class AuthService {',
      '  login(user: string, pass: string, token: string): boolean {',
      '    return true;',
      '  }',
      '}',
    ].join('\n')
  );

  // Define changed file set between r1001 and r1002
  vcs.setChangeSet(baseRev, candRev, [
    {
      filePath: 'src/auth/service.ts',
      changeType: 'MODIFIED',
    },
  ]);

  // Step A: Create ECM using non-Git revision identities
  const builder = new EcmBuilder(workspaceId, baseRev, candRev);
  builder.expectFile({
    filePath: 'src/auth/service.ts',
    changeType: 'MODIFIED',
    provenance: 'DEVELOPER_DECLARED',
    confidence: 1.0,
  });
  builder.expectSymbol({
    filePath: 'src/auth/service.ts',
    symbolName: 'AuthService.login',
    changeType: 'SIGNATURE_CHANGED',
    provenance: 'DEVELOPER_DECLARED',
    confidence: 0.95,
  });
  const ecm = builder.build();

  assert.strictEqual(ecm.baseCommitSha, 'r1001', 'Opaque revision id accepted as baseCommitSha');
  assert.strictEqual(ecm.candidateCommitSha, 'r1002', 'Opaque revision id accepted as candidateCommitSha');

  // Step B: Evaluate change purely via IRepositoryStateProvider
  const actualChangedFiles = await vcs.getActualChangeSet(ecm.baseCommitSha, ecm.candidateCommitSha);
  assert.strictEqual(actualChangedFiles.length, 1);
  assert.strictEqual(actualChangedFiles[0].filePath, 'src/auth/service.ts');

  // Step C: Execute AST Diff with non-Git LazyBeforeStateProvider
  const beforeProvider = new LazyBeforeStateProvider(process.cwd(), {
    repositoryProvider: vcs,
  });
  const diffEngine = new AstStructuralDiffEngine(beforeProvider);
  const diff = await diffEngine.computeDiff(
    ecm.changeId,
    ecm.workspaceId,
    ecm.baseCommitSha,
    ecm.candidateCommitSha,
    actualChangedFiles
  );

  assert.strictEqual(diff.fileDeltas.length, 1);
  assert.strictEqual(diff.summary.symbolsSignatureChanged, 1, 'Signature change detected via non-Git provider');

  // Step D: Reconcile with Evidence Ledger
  const ledgerService = new ChangeEvidenceLedgerService();
  const ledger = ledgerService.initializeLedger(ecm);
  ledgerService.ingestAstDiffAndBoundary(ledger, ecm, diff);
  const closedLedger = ledgerService.reconcileAndClose(ledger);

  assert.strictEqual(closedLedger.status, 'CLOSED');
  assert.strictEqual(closedLedger.verdict, 'WARN', 'Fallback parser yields PARTIAL confidence and WARN verdict');
  assert.strictEqual(closedLedger.counts.satisfied, 2);
  assert.strictEqual(closedLedger.counts.boundaryViolations, 0);
  assert.strictEqual(closedLedger.vcs, 0.595);

  // Step E: Determinism Verification (Test 5)
  // Run a second pass with identical input and verify identical deterministic output
  const diff2 = await diffEngine.computeDiff(
    ecm.changeId,
    ecm.workspaceId,
    ecm.baseCommitSha,
    ecm.candidateCommitSha,
    actualChangedFiles
  );
  const ledger2 = ledgerService.initializeLedger(ecm);
  ledgerService.ingestAstDiffAndBoundary(ledger2, ecm, diff2);
  const closedLedger2 = ledgerService.reconcileAndClose(ledger2);

  assert.strictEqual(closedLedger.changeId, closedLedger2.changeId, 'ChangeId must be strictly deterministic');
  assert.strictEqual(closedLedger.vcs, closedLedger2.vcs, 'VCS score must be strictly deterministic');
  assert.strictEqual(closedLedger.verdict, closedLedger2.verdict, 'ChangeVerdict must be strictly deterministic');
  assert.deepStrictEqual(closedLedger.counts, closedLedger2.counts, 'Counts must be strictly deterministic');

  console.log('✓ VCS-Agnostic Core Architecture & Provider Substitution Tests Passed.');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
