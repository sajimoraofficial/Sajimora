import * as fs from 'node:fs';
import { getAllCoverageQueries } from './coverage_query_registry_v1';

type RootCause = {
  rootCauseId: string; description: string; pipelineStage: string; category: string;
  suspectedProductionComponent: string; genericFixDirection: string; risk: string; priority: string;
  genericity: 'GENERIC' | 'CAMPAIGN_CONTRACT';
};

const causes: Record<string, RootCause> = {
  RC001_IDENTICAL_INPUT_EXPECTED_PRESERVED: {
    rootCauseId: 'RC001_IDENTICAL_INPUT_EXPECTED_PRESERVED', category: 'APPLICABILITY',
    description: 'Parent and candidate snapshots are byte-identical. The analyzer correctly finds no semantic change and creates no obligations, while the campaign oracle expects PRESERVED.',
    pipelineStage: 'INPUT_CONTRACT', suspectedProductionComponent: 'None; campaign query construction/oracle semantics',
    genericFixDirection: 'Define no-change controls as NOT_APPLICABLE or exclude them from change-verdict accuracy while retaining them as invariance tests.',
    risk: 'LOW', priority: 'P0_MEASUREMENT', genericity: 'CAMPAIGN_CONTRACT'
  },
  RC002_GENERIC_CONSTRAINT_OMITTED_FROM_CHANGE_FINGERPRINT: {
    rootCauseId: 'RC002_GENERIC_CONSTRAINT_OMITTED_FROM_CHANGE_FINGERPRINT', category: 'CHANGE_DETECTION',
    description: 'Generic type-parameter constraints change, but the signature fingerprint remains `(x: T) => T`; dependencyHash/typeParameters differ and are ignored when assigning UNCHANGED.',
    pipelineStage: 'CHANGED_SEMANTIC_ENTITIES', suspectedProductionComponent: 'TypeCheckerSemanticAnalyzer.ts; TypeScriptProductionAdapter.ts identity/change comparison',
    genericFixDirection: 'Include normalized type-parameter constraints/defaults and other public generic semantics in API fingerprints and semantic deltas.',
    risk: 'MEDIUM', priority: 'P0', genericity: 'GENERIC'
  },
  RC003_ADDITIVE_EXPORT_LEGITIMATE_NOT_APPLICABLE: {
    rootCauseId: 'RC003_ADDITIVE_EXPORT_LEGITIMATE_NOT_APPLICABLE', category: 'APPLICABILITY',
    description: 'A newly exported declaration has no historical contract or historical consumer to preserve; provider evaluation explicitly emits EXPORTED_API_ADDED/NOT_APPLICABLE.',
    pipelineStage: 'EVIDENCE_GENERATION', suspectedProductionComponent: 'TypeScriptProviderApiEvaluator.ts',
    genericFixDirection: 'Retain the semantic rule; align reporting so additive API is distinguished from preservation rather than weakening NOT_APPLICABLE.',
    risk: 'LOW', priority: 'P0_MEASUREMENT', genericity: 'CAMPAIGN_CONTRACT'
  },
  RC004_CROSS_PROGRAM_TYPE_ASSIGNABILITY: {
    rootCauseId: 'RC004_CROSS_PROGRAM_TYPE_ASSIGNABILITY', category: 'TYPE_RELATION',
    description: 'The candidate TypeChecker is asked to compare a candidate ts.Type with a parent ts.Type owned by a different Program/TypeChecker. Cross-program type objects do not form a valid TypeScript assignability relation and safe changes are reported as API_NOT_ASSIGNABLE.',
    pipelineStage: 'EVIDENCE_GENERATION', suspectedProductionComponent: 'TypeScriptProviderApiEvaluator.ts',
    genericFixDirection: 'Compare contracts inside one checker-owned compatibility environment or lower both revisions to a sound cross-version type IR with directional rules.',
    risk: 'HIGH', priority: 'P0', genericity: 'GENERIC'
  },
  RC005_VIRTUAL_PATH_CANONICALIZATION_MISMATCH: {
    rootCauseId: 'RC005_VIRTUAL_PATH_CANONICALIZATION_MISMATCH', category: 'EVIDENCE_GENERATION',
    description: 'Extracted entity paths are frequently rooted (`/src/...`) while snapshot keys are relative (`src/...`). Candidate-context preflight calls readTextFile without normalization and emits MISSING_SEALED_CONSUMER_SOURCE despite source being present.',
    pipelineStage: 'EVIDENCE_GENERATION', suspectedProductionComponent: 'TypeScriptCandidateContext.ts and virtual snapshot path contract',
    genericFixDirection: 'Establish one canonical virtual-path representation at snapshot boundaries and use canonical reads everywhere.',
    risk: 'MEDIUM', priority: 'P0', genericity: 'GENERIC'
  },
  RC006_OPERATIONAL_FRAGMENT_UNSUPPORTED: {
    rootCauseId: 'RC006_OPERATIONAL_FRAGMENT_UNSUPPORTED', category: 'EVIDENCE_GENERATION',
    description: 'Behavioral obligations reach the restricted operational evaluator, which cannot materialize/prove the changed fragment and emits OPERATIONAL_FRAGMENT_UNSUPPORTED; consumer checks also encounter the path boundary.',
    pipelineStage: 'EVIDENCE_GENERATION', suspectedProductionComponent: 'TypeScriptOperationalEvaluator.ts; TypeScriptCandidateContext.ts',
    genericFixDirection: 'Expand only formally justified operational fragments and retain UNKNOWN for behavior outside the supported proof domain.',
    risk: 'HIGH', priority: 'P2', genericity: 'GENERIC'
  },
  RC007_JSX_CONSUMER_DISCOVERY_SELF_REFERENCE_ONLY: {
    rootCauseId: 'RC007_JSX_CONSUMER_DISCOVERY_SELF_REFERENCE_ONLY', category: 'JSX_SEMANTICS',
    description: 'Reference discovery finds the props type reference inside the provider component but misses the JSX consumer in the separate consumer file. Evaluation then rejects the self-reference as PROVIDER_CONSUMER_OVERLAP.',
    pipelineStage: 'ACTUAL_REFERENCES_CONSUMERS', suspectedProductionComponent: 'TypeCheckerSemanticAnalyzer.ts JSX/reference discovery; TypeScriptCandidateContext.ts',
    genericFixDirection: 'Resolve JSX tag symbols through aliases to component/props identities and exclude provider-internal references from external consumer completeness.',
    risk: 'HIGH', priority: 'P1', genericity: 'GENERIC'
  },
  RC008_WORKSPACE_DEPENDENCY_CLOSURE_UNAVAILABLE: {
    rootCauseId: 'RC008_WORKSPACE_DEPENDENCY_CLOSURE_UNAVAILABLE', category: 'WORKSPACE_PROJECT_GRAPH',
    description: 'Workspace package imports cannot be reconstructed in the sealed compiler environment, so provider evidence emits DEPENDENCY_CLOSURE_UNAVAILABLE and no confirmed consumers are found.',
    pipelineStage: 'PROJECT_GRAPH_MODULE_RESOLUTION', suspectedProductionComponent: 'TypeScriptProjectGraphBuilder.ts; ProgramSetManager.ts; sealed compiler host/module resolver',
    genericFixDirection: 'Build workspace/package edges from manifests and lockfiles, then resolve each revision using its actual project/package topology.',
    risk: 'HIGH', priority: 'P1', genericity: 'GENERIC'
  },
  RC009_PROJECT_ENVIRONMENT_CHANGE_NOT_RECONSTRUCTED: {
    rootCauseId: 'RC009_PROJECT_ENVIRONMENT_CHANGE_NOT_RECONSTRUCTED', category: 'MODULE_RESOLUTION',
    description: 'A changed package/exports environment is represented as unresolved identity PROJECT_ENVIRONMENT_CHANGED instead of reconstructing and comparing the two resolution environments.',
    pipelineStage: 'PROJECT_GRAPH_COMPILER_ENVIRONMENT', suspectedProductionComponent: 'TypeScriptProductionAdapter.ts environment change boundary; project/package resolver',
    genericFixDirection: 'Reconstruct parent and candidate package-export resolution independently and compare selected declarations with provenance.',
    risk: 'HIGH', priority: 'P1', genericity: 'GENERIC'
  },
  RC010_RELOCATION_IDENTITY_AMBIGUOUS: {
    rootCauseId: 'RC010_RELOCATION_IDENTITY_AMBIGUOUS', category: 'SEMANTIC_IDENTITY',
    description: 'A renamed/relocated declaration is matched only heuristically and deliberately marked AMBIGUOUS_IDENTITY, preventing certification.',
    pipelineStage: 'CROSS_VERSION_SEMANTIC_IDENTITY', suspectedProductionComponent: 'TypeScriptProductionAdapter.ts relocation identity mapping',
    genericFixDirection: 'Use export graph, alias lineage, module resolution and declaration semantics to prove relocations; retain ambiguity when proof is absent.',
    risk: 'HIGH', priority: 'P2', genericity: 'GENERIC'
  },
  RC011_COMPILER_STATIC_PRESERVATION_REJECTED_BY_AUTHORITY: {
    rootCauseId: 'RC011_COMPILER_STATIC_PRESERVATION_REJECTED_BY_AUTHORITY', category: 'ASSURANCE_BOUNDARY',
    description: 'Every obligation has COMPILER_STATIC/PRESERVED evidence, but the core marks non-F0 preservation UNCERTIFIED_UNKNOWN and frozen VerdictAuthority intentionally rejects certification.',
    pipelineStage: 'FROZEN_VERDICT_AUTHORITY', suspectedProductionComponent: 'ProductionVerificationCore.ts assurance classification; TypeScriptProductionF0Materializer.ts evidence availability; VerdictAuthority unchanged',
    genericFixDirection: 'Provide qualifying F0 proof for a narrowly defined property, or expose compiler type-compatibility as a non-authoritative result without calling it certified behavioral preservation.',
    risk: 'VERY_HIGH', priority: 'P1_PRODUCT_CONTRACT', genericity: 'GENERIC'
  },
  ROOT_CAUSE_UNRESOLVED: {
    rootCauseId: 'ROOT_CAUSE_UNRESOLVED', category: 'OTHER', description: 'Captured evidence is insufficient for deterministic classification.',
    pipelineStage: 'UNRESOLVED', suspectedProductionComponent: 'Unknown', genericFixDirection: 'Capture missing stage evidence before implementation.',
    risk: 'UNKNOWN', priority: 'P0_DIAGNOSTIC', genericity: 'GENERIC'
  }
};

const diagnostic = JSON.parse(fs.readFileSync('semantic_coverage_mismatch_diagnostic_v1.json', 'utf8'));
const queries = new Map(getAllCoverageQueries().map(query => [query.id, query]));

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(a).sort(([x], [y]) => x.localeCompare(y))) === JSON.stringify(Object.entries(b).sort(([x], [y]) => x.localeCompare(y)));
}

function classify(record: any): string {
  const query = queries.get(record.id)!;
  const obligations = record.pipeline?.obligations ?? [];
  const verdicts = record.pipeline?.verdicts ?? [];
  const unknownReasons = new Set(verdicts.filter((v: any) => v.outcome === 'UNKNOWN').map((v: any) => v.evidenceReason));
  if (obligations.length === 0) {
    if (sameFiles(query.parentFiles, query.candidateFiles)) return 'RC001_IDENTICAL_INPUT_EXPECTED_PRESERVED';
    const constraintsChanged = (record.pipeline.changes ?? []).some((change: any) => change.changeKind === 'UNCHANGED' &&
      JSON.stringify(change.parent?.metadata?.typeParameters) !== JSON.stringify(change.candidate?.metadata?.typeParameters));
    if (constraintsChanged) return 'RC002_GENERIC_CONSTRAINT_OMITTED_FROM_CHANGE_FINGERPRINT';
  }
  if (record.actualVerdict === 'NOT_APPLICABLE' && verdicts.some((v: any) => v.evidenceReason === 'EXPORTED_API_ADDED')) return 'RC003_ADDITIVE_EXPORT_LEGITIMATE_NOT_APPLICABLE';
  if (record.actualVerdict === 'VIOLATED' && verdicts.some((v: any) => v.outcome === 'VIOLATED' && v.evidence?.metadata?.route === 'TYPESCRIPT_DIRECTIONAL_PROVIDER_ASSIGNABILITY_V1')) return 'RC004_CROSS_PROGRAM_TYPE_ASSIGNABILITY';
  if (unknownReasons.has('OPERATIONAL_FRAGMENT_UNSUPPORTED')) return 'RC006_OPERATIONAL_FRAGMENT_UNSUPPORTED';
  if (unknownReasons.has('PROVIDER_CONSUMER_OVERLAP')) return 'RC007_JSX_CONSUMER_DISCOVERY_SELF_REFERENCE_ONLY';
  if (unknownReasons.has('DEPENDENCY_CLOSURE_UNAVAILABLE')) return 'RC008_WORKSPACE_DEPENDENCY_CLOSURE_UNAVAILABLE';
  if (unknownReasons.has('PROJECT_ENVIRONMENT_CHANGED')) return 'RC009_PROJECT_ENVIRONMENT_CHANGE_NOT_RECONSTRUCTED';
  if (unknownReasons.has('AMBIGUOUS_IDENTITY')) return 'RC010_RELOCATION_IDENTITY_AMBIGUOUS';
  if (unknownReasons.has('MISSING_SEALED_CONSUMER_SOURCE')) return 'RC005_VIRTUAL_PATH_CANONICALIZATION_MISMATCH';
  if (record.actualVerdict === 'UNKNOWN' && verdicts.length > 0 && verdicts.every((v: any) => v.outcome === 'PRESERVED' && v.assurance === 'COMPILER_STATIC')) return 'RC011_COMPILER_STATIC_PRESERVATION_REJECTED_BY_AUTHORITY';
  return 'ROOT_CAUSE_UNRESOLVED';
}

function counts(values: string[]): Record<string, number> {
  return Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]));
}

const ledger = diagnostic.records.map((record: any) => {
  const rootCauseId = classify(record);
  const verdicts = record.pipeline?.verdicts ?? [];
  const obligations = record.pipeline?.obligations ?? [];
  const evidenceReasons = [...new Set(verdicts.map((v: any) => v.evidenceReason).filter(Boolean))];
  const evidence = verdicts.map((v: any) => ({ obligationId: v.obligationId, outcome: v.outcome, assurance: v.assurance,
    property: v.property, reasonCode: v.evidenceReason, route: v.evidence?.metadata?.route,
    diagnostics: v.evidence?.compilerStatic?.introducedDiagnostics ?? [], assignabilityWitness: v.evidence?.compilerStatic?.assignabilityWitness }));
  const why = rootCauseId === 'RC004_CROSS_PROGRAM_TYPE_ASSIGNABILITY'
    ? 'The API_NOT_ASSIGNABLE witness is invalid as cross-revision ts.Type objects belong to different checker instances.'
    : rootCauseId === 'RC011_COMPILER_STATIC_PRESERVATION_REJECTED_BY_AUTHORITY'
      ? 'Compiler-static type evidence is present but is intentionally below the frozen authority threshold for certified PRESERVED.'
      : rootCauseId === 'RC001_IDENTICAL_INPUT_EXPECTED_PRESERVED'
        ? 'There is no semantic delta to verify; no evidence or obligation is warranted.'
        : evidenceReasons.length ? `Evaluation stopped at ${evidenceReasons.join(', ')}.`
          : 'No changed semantic entity reached obligation generation.';
  return {
    id: record.id, expectedVerdict: record.expectedVerdict, actualVerdict: record.actualVerdict,
    rootCauseId, rootCauseCategory: causes[rootCauseId].category, pipelineStage: causes[rootCauseId].pipelineStage,
    reasonCodes: evidenceReasons.length ? evidenceReasons : [rootCauseId],
    tier: record.tier, level: record.level, family: record.family, features: record.features,
    changeSummary: (record.pipeline?.changes ?? []).map((change: any) => ({ changeKind: change.changeKind,
      identityStatus: change.identityStatus, ambiguityReasons: change.ambiguityReasons,
      entityName: change.parent?.name ?? change.candidate?.name, entityKind: change.parent?.kind ?? change.candidate?.kind,
      parentFile: change.parent?.filePath, candidateFile: change.candidate?.filePath })),
    obligationsGenerated: obligations.length > 0, obligationCount: obligations.length,
    obligations: obligations.map((obligation: any) => ({ question: obligation.question, scope: obligation.scope,
      changeKind: obligation.changeKind, referenceKind: obligation.referenceKind, boundaryReason: obligation.boundaryReason })),
    discovery: { staticReferences: record.pipeline?.staticReferenceCount ?? 0,
      unresolvedReferences: record.pipeline?.unresolvedReferenceCount ?? 0,
      references: (record.pipeline?.references ?? []).map((reference: any) => ({ kind: reference.kind, location: reference.location,
        unresolved: reference.unresolved, reason: reference.reason })) },
    evidence, whyEvidenceInsufficientOrIncorrect: why, genericity: causes[rootCauseId].genericity
  };
});

const frequency = counts(ledger.map((entry: any) => entry.rootCauseId));
const total = Object.values(frequency).reduce((sum, value) => sum + value, 0);
if (total !== 652 || ledger.length !== 652) throw new Error(`Accounting failure: ledger=${ledger.length}, classified=${total}`);
if ((frequency.ROOT_CAUSE_UNRESOLVED ?? 0) !== 0) throw new Error(`Unclassified mismatches: ${frequency.ROOT_CAUSE_UNRESOLVED}`);

const taxonomy = Object.values(causes).filter(cause => cause.rootCauseId !== 'ROOT_CAUSE_UNRESOLVED').map(cause => {
  const affected = ledger.filter((entry: any) => entry.rootCauseId === cause.rootCauseId);
  return { ...cause, affectedCount: affected.length, affectedQueries: affected.map((entry: any) => entry.id),
    semanticFamilies: [...new Set(affected.map((entry: any) => entry.family))].sort(),
    queryGroups: [...new Set(affected.map((entry: any) => entry.id.split('-').slice(0, 2).join('-')))].sort(),
    expectedActualPatterns: counts(affected.map((entry: any) => `${entry.expectedVerdict}->${entry.actualVerdict}`)) };
});

fs.writeFileSync('semantic_coverage_failure_ledger_652.json', JSON.stringify({ version: '1.0.0',
  sourceDiagnosticLedger: 'semantic_coverage_mismatch_diagnostic_v1.json', mismatchCount: ledger.length,
  classifiedCount: total, unclassifiedCount: frequency.ROOT_CAUSE_UNRESOLVED ?? 0, frequency, taxonomy, failures: ledger }, null, 2));

const table = taxonomy.sort((a, b) => b.affectedCount - a.affectedCount)
  .map(cause => `| ${cause.rootCauseId} | ${cause.affectedCount} | ${cause.pipelineStage} | ${cause.queryGroups.join(', ')} | ${cause.priority} |`)
  .join('\n');
const report = `# TypeScript Semantic Coverage: 652-Mismatch Root-Cause Analysis\n\n` +
  `Production code was inspected read-only and was not modified. Classification is based on a deterministic stage replay of all 652 frozen mismatches.\n\n` +
  `## Accounting\n\n- Frozen mismatches: 652\n- Classified: ${total}\n- Unclassified: ${frequency.ROOT_CAUSE_UNRESOLVED ?? 0}\n- Check: **${total} = 652**\n\n` +
  `## Root-cause frequency\n\n| Root cause | Count | Pipeline stage | Query groups | Priority |\n|---|---:|---|---|---|\n${table}\n\n` +
  `## Taxonomy details\n\n` + taxonomy.map(cause => `### ${cause.rootCauseId} (${cause.affectedCount})\n\n` +
    `- Category: ${cause.category}\n- Description: ${cause.description}\n- Stage: ${cause.pipelineStage}\n` +
    `- Patterns: ${JSON.stringify(cause.expectedActualPatterns)}\n- Families: ${cause.semanticFamilies.join(', ')}\n` +
    `- Evidence/component: ${cause.suspectedProductionComponent}\n- Direction: ${cause.genericFixDirection}\n` +
    `- Genericity: ${cause.genericity}\n- Risk: ${cause.risk}; priority: ${cause.priority}\n`).join('\n') +
  `\n## Required focused analyses\n\n` +
  `### Zero obligations\n\n167 mismatches generated zero obligations: 127 byte-identical parent/candidate controls (RC001), and 40 real generic-constraint changes hidden by incomplete fingerprints (RC002).\n\n` +
  `### NOT_APPLICABLE\n\n170 mismatches returned NOT_APPLICABLE: 127 legitimate no-change cases (RC001), 40 incorrect applicability failures after missed generic changes (RC002), and 3 legitimate additive-export cases (RC003).\n\n` +
  `### Decidable to UNKNOWN\n\n363 decidable cases returned UNKNOWN: 245 path-canonicalization failures (RC005), 17 restricted operational fragments (RC006), 40 missed JSX consumers/self-reference overlap (RC007), 35 workspace dependency closures (RC008), 13 unreconstructed project environments (RC009), 3 ambiguous relocations (RC010), and 10 intentional authority rejections of compiler-static preservation (RC011).\n\n` +
  `### False VIOLATED\n\nAll 119 false VIOLATED results are RC004. Every violation came from API_COMPATIBILITY using TYPESCRIPT_DIRECTIONAL_PROVIDER_ASSIGNABILITY_V1; no consumer or behavioral evaluator produced these false violations.\n\n` +
  `### PRESERVED blockage\n\nOf 427 expected PRESERVED cases: 119 became false VIOLATED (RC004); 99 became UNKNOWN through path canonicalization (RC005); 17 through workspace closure (RC008); 20 through JSX discovery (RC007); 9 through unsupported operational proof (RC006); 3 through ambiguous identity (RC010); 10 had complete COMPILER_STATIC/PRESERVED evidence but frozen authority intentionally rejected non-F0 preservation (RC011); 127 were identical-input NOT_APPLICABLE controls (RC001); 20 missed generic changes (RC002); and 3 were legitimate additive-export NOT_APPLICABLE cases (RC003).\n\n` +
  `## Ranked engineering backlog\n\n1. P0: establish canonical virtual paths end-to-end (RC005, 245).\n2. P0: replace cross-Program ts.Type comparison with a sound same-checker or cross-version IR relation (RC004, 119).\n3. P0: include public generic constraints/defaults in semantic fingerprints (RC002, 40).\n4. P0 measurement: separate identical-input and additive-API applicability controls from preservation accuracy (RC001 + RC003, 130; no production weakening).\n5. P1: implement compiler-proven JSX consumer discovery (RC007, 40).\n6. P1: reconstruct workspace dependency closure (RC008, 35).\n7. P1: reconstruct changed package/export environments per revision (RC009, 13).\n8. P1 product contract: add qualifying proof only for narrowly supported preservation properties or report compiler compatibility separately; do not modify frozen authority (RC011, 10 observed after other blockers).\n9. P2: strengthen relocation identity proof using export/alias lineage (RC010, 3).\n10. P2: expand formally justified operational fragments while retaining UNKNOWN elsewhere (RC006, 17).\n\n` +
  `The complete mismatch-to-root-cause mapping, obligation/reference status, and evidence summary is in semantic_coverage_failure_ledger_652.json. Raw per-stage evidence is in semantic_coverage_mismatch_diagnostic_v1.json.\n`;
fs.writeFileSync('semantic_coverage_mismatch_root_cause_report.md', report);
console.log(JSON.stringify({ total, unclassified: frequency.ROOT_CAUSE_UNRESOLVED ?? 0, frequency }, null, 2));
