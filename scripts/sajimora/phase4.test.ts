import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DualTypeScriptProgramBuilder,
  GitDiffReader,
  GitObjectReader,
  GitRepository,
  SnapshotFilesystem,
  TypeScriptCrossVersionIdentityAnalyzer,
  TypeScriptV1Adapter,
  TypeScriptCompatibility,
  LiveProgramSemanticProvider,
  AuthorityIntegrationLayer,
  Phase4EvidenceAssembler
} from '@sajimora/analysis';
import {
  ProofObligation,
  CompleteProofEvidence,
  VerdictAuthority,
  validateProofTree
} from '@sajimora/core';
import { phase1ArtifactSchema, serializePhase1Artifact, Phase1Artifact } from './artifact';

console.log('Running Sajimora Phase 4 End-to-End Integration Suite...');

const git = (r: string, a: string[]) => execFileSync('git', ['-C', r, ...a], { encoding: 'utf8' }).trim();
const write = (r: string, f: string, t: string) => {
  const p = path.join(r, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, t);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-phase4-'));

try {
  git(root, ['init']);
  git(root, ['config', 'user.email', 'p4@example.invalid']);
  git(root, ['config', 'user.name', 'P4']);

  write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }));
  write(root, 'src/a.ts', 'export function oldName(x: string): string { return x; }\n');
  write(root, 'src/consumer.ts', "import { oldName } from './a'; export const result = oldName('x');\n");
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'parent']);
  const parentSha = git(root, ['rev-parse', 'HEAD']);

  // 1. Incompatible mutation: string -> number
  write(root, 'src/a.ts', 'export function oldName(x: number): string { return String(x); }\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'candidate-incompatible']);
  const candIncompatibleSha = git(root, ['rev-parse', 'HEAD']);

  const repo = new GitRepository(root);
  const snaps = new SnapshotFilesystem(new GitObjectReader(repo));
  const ps = snaps.materialize(parentSha);
  const csIncomp = snaps.materialize(candIncompatibleSha);

  try {
    const adapter = new TypeScriptV1Adapter();
    const input = (s: typeof ps, sha: string) => ({
      root: s.root,
      trackedFiles: s.trackedFiles,
      revision: { repositoryId: repo.repositoryId(), commitSha: sha },
      toolchain: adapter.toolchain({ trackedFiles: s.trackedFiles, readTextFile: f => s.readTextFile(f) }),
      adapterId: adapter.descriptor.id,
      adapterVersion: adapter.descriptor.version
    });

    const dualIncomp = new DualTypeScriptProgramBuilder().build(input(ps, parentSha), input(csIncomp, candIncompatibleSha));
    const analyzer = new TypeScriptCrossVersionIdentityAnalyzer();
    const diffsIncomp = new GitDiffReader(repo).read(parentSha, candIncompatibleSha);
    const idBundleIncomp = analyzer.analyze(dualIncomp.parent, dualIncomp.candidate, ps.root, csIncomp.root, diffsIncomp);

    const obligation: ProofObligation = {
      invariantId: 'ob-incomp',
      relation: 'STRUCTURAL_CO_EVOLUTION',
      mutatedSymbol: {
        symbolId: 'src/a.ts#oldName',
        kind: 'FUNCTION',
        name: 'oldName',
        declarationPath: 'src/a.ts',
        declarationOrdinal: 0
      } as any,
      providerMutation: {
        classification: 'EXPORTED_SIGNATURE_MUTATED',
        beforeSnippet: 'export function oldName(x: string): string',
        afterSnippet: 'export function oldName(x: number): string',
        targetSymbol: {
          symbolId: 'src/a.ts#oldName',
          kind: 'FUNCTION',
          name: 'oldName',
          declarationPath: 'src/a.ts',
          declarationOrdinal: 0
        }
      } as any
    };

    // Locate candidate declaration node
    const candProg = dualIncomp.candidate.projects[0].program;
    const parentProg = dualIncomp.parent.projects[0].program;
    const candSf = candProg.getSourceFile(path.join(csIncomp.root, 'src/a.ts'))!;
    let candDeclNode = (candSf as any).statements[0];

    const evaluatorIncomp = new TypeScriptCompatibility(undefined, obligation, {
      isPhase4Mode: true,
      provider: new LiveProgramSemanticProvider({
        parentProgram: parentProg,
        candidateProgram: candProg,
        obligation,
        candidateDeclarationNode: candDeclNode
      })
    });

    const consumerSite: any = {
      usageSiteId: 'consumer-1',
      canonicalOccurrence: {
        occurrenceId: 'occ-consumer-1',
        symbolId: 'src/a.ts#oldName',
        sourceFile: path.join(ps.root, 'src/consumer.ts'),
        sourceSpan: { start: 40, end: 66, line: 1, column: 41, endLine: 1, endColumn: 67 },
        usageRole: 'CALL_SITE',
        resolutionStatus: 'RESOLVED',
        provenanceTrace: []
      },
      existenceAtParent: 'PRESENT',
      mutationStatus: 'UNCHANGED',
      bindingPresenceAtCandidate: 'PRESENT',
      bindingState: 'BOUND',
      evaluationStatus: 'EVALUABLE',
      identityResult: 'SAME',
      enumerationInconsistencyCause: null,
      provenance: 'UNCHANGED'
    };

    const resIncomp = evaluatorIncomp.evaluateSite(consumerSite);
    assert.equal(resIncomp.status, 'INCOMPATIBLE');
    assert.ok(resIncomp.phase4Evidence);
    assert.equal(resIncomp.phase4Evidence.witness.semanticRelation, 'PARAMETER_ACCEPTS_ARGUMENT');
    console.log('  ✅ PASS: Dual-program breaking parameter mutation proven INCOMPATIBLE with witness');

    // 2. Compatible mutation: string -> string | number (widening)
    write(root, 'src/a.ts', 'export function oldName(x: string | number): string { return String(x); }\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'candidate-compatible']);
    const candCompatibleSha = git(root, ['rev-parse', 'HEAD']);

    const csComp = snaps.materialize(candCompatibleSha);
    try {
      const dualComp = new DualTypeScriptProgramBuilder().build(input(ps, parentSha), input(csComp, candCompatibleSha));
      const candProgComp = dualComp.candidate.projects[0].program;
      const parentProgComp = dualComp.parent.projects[0].program;
      const candSfComp = candProgComp.getSourceFile(path.join(csComp.root, 'src/a.ts'))!;
      const candDeclComp = (candSfComp as any).statements[0];

      const evaluatorComp = new TypeScriptCompatibility(undefined, obligation, {
        isPhase4Mode: true,
        provider: new LiveProgramSemanticProvider({
          parentProgram: parentProgComp,
          candidateProgram: candProgComp,
          obligation,
          candidateDeclarationNode: candDeclComp
        })
      });

      const resComp = evaluatorComp.evaluateSite(consumerSite);
      assert.equal(resComp.status, 'COMPATIBLE');
      assert.ok(resComp.phase4Evidence);
      assert.equal(validateProofTree(resComp.phase4Evidence.proofTree).isValid, true);
      console.log('  ✅ PASS: Dual-program widening parameter mutation proven COMPATIBLE with valid proof tree');

      // 3. Full VerdictAuthority Integration
      const compResults = new Map<string, any>();
      compResults.set(consumerSite.usageSiteId, resComp);

      const completeClosure = {
        completeness: 'COMPLETE',
        failures: [],
        ambiguities: [],
        unrecognizedForms: [],
        status: 'DISCOVERY_COMPLETE_WITHIN_ANALYSIS_UNIVERSE'
      };

      const completeEvidence: CompleteProofEvidence<any> = {
        triggerData: null,
        obligation,
        analysisUniverse: {
          discoveryStatus: 'DISCOVERY_COMPLETE',
          parseFailures: new Map(),
          unreadableFiles: [],
          excludedFiles: new Map()
        } as any,
        closures: {
          valueReference: { ...completeClosure, occurrences: [consumerSite.canonicalOccurrence] },
          typeReference: { ...completeClosure, occurrences: [] },
          inheritance: { ...completeClosure, occurrences: [] },
          interfaceImpl: { ...completeClosure, occurrences: [] },
          override: { ...completeClosure, occurrences: [] },
          reExport: { ...completeClosure, occurrences: [] },
          ambientReference: { ...completeClosure, occurrences: [] }
        } as any,
        canonicalOccurrences: [consumerSite],
        identityResults: [
          {
            usageSiteId: consumerSite.usageSiteId,
            referencedSymbol: consumerSite.canonicalOccurrence.symbolId,
            declarationSymbol: consumerSite.canonicalOccurrence.symbolId,
            resolutionStatus: 'RESOLVED',
            identityResult: 'SAME',
            evaluationStatus: 'EVALUABLE'
          }
        ],
        compatibilityResults: compResults,
        semanticScope: { unsupportedRelationshipPossible: false, reason: 'TS_VALUE_LEVEL_NO_IMPLICIT' }
      };

      const reconciled = AuthorityIntegrationLayer.reconcileAndIntegrate(completeEvidence, {
        isPhase4Mode: true
      });

      const verdict = VerdictAuthority.evaluateProof(reconciled);
      assert.equal(verdict.verdict, 'PRESERVED');
      console.log('  ✅ PASS: Reconciled proof evidence passes VerdictAuthority to reach PRESERVED');

      // 4. Artifact Assembly & Deterministic Serialization
      const bundle = Phase4EvidenceAssembler.assembleBundle(compResults);
      assert.equal(bundle.proofStats.compatibleCount, 1);
      assert.equal(bundle.proofStats.incompatibleCount, 0);

      const artifact: Phase1Artifact = {
        schemaVersion: 'SAJIMORA_ANALYSIS_ARTIFACT_V2',
        repository: { repositoryId: repo.repositoryId() },
        revisions: {
          parent: { repositoryId: repo.repositoryId(), commitSha: parentSha },
          candidate: {
            repositoryId: repo.repositoryId(),
            commitSha: candCompatibleSha,
            parentSelection: { strategy: 'EXPLICIT_PARENT', selectedParentSha: parentSha }
          }
        },
        adapter: {
          id: adapter.descriptor.id,
          version: adapter.descriptor.version,
          capabilities: adapter.descriptor.capabilities,
          selection: { mode: 'auto', evidence: [] },
          toolchain: adapter.toolchain({ trackedFiles: ps.trackedFiles, readTextFile: f => ps.readTextFile(f) })
        },
        crossVersionIdentity: idBundleIncomp,
        semanticCompatibility: {
          schemaVersion: 'SAJIMORA_COMPATIBILITY_EVIDENCE_V1',
          engineVersion: '33.0.0',
          evaluatedConsumers: [
            {
              consumerMappingId: consumerSite.usageSiteId,
              status: 'COMPATIBLE',
              reason: null,
              proofTree: resComp.phase4Evidence.proofTree
            }
          ],
          witnesses: [],
          blockerSummary: [],
          typeIRStats: bundle.typeIRStats,
          proofStats: bundle.proofStats,
          phase4Outcome: {
            allConsumersEvaluated: bundle.phase4Outcome.allConsumersEvaluated,
            coverageGaps: [...bundle.phase4Outcome.coverageGaps]
          }
        },
        analysis: {
          status: 'COMPLETED',
          changedFiles: ['src/a.ts'],
          results: [
            {
              obligationId: obligation.invariantId,
              target: {
                name: 'oldName',
                kind: 'FUNCTION',
                file: 'src/a.ts',
                line: 1
              },
              verdict: 'PRESERVED',
              authority: {
                source: 'VERDICT_AUTHORITY',
                gate: 'PRESERVED_CHECK',
                reason: 'ALL_EVALUABLE_COMPATIBLE'
              }
            }
          ]
        }
      };

      const serialized1 = serializePhase1Artifact(artifact, { snapshotRoots: [ps.root, csComp.root] });
      const serialized2 = serializePhase1Artifact(artifact, { snapshotRoots: [ps.root, csComp.root] });
      assert.equal(serialized1, serialized2);
      assert.ok(phase1ArtifactSchema.parse(JSON.parse(serialized1)));
      assert.equal(serialized1.includes(ps.root), false);
      assert.equal(serialized1.includes(csComp.root), false);
      console.log('  ✅ PASS: Artifact serialization passes Zod schema and is 100% byte-identical deterministic');
    } finally {
      csComp.cleanup();
    }
  } finally {
    ps.cleanup();
    csIncomp.cleanup();
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\nAll Phase 4 Integration Tests Passed Successfully!');
