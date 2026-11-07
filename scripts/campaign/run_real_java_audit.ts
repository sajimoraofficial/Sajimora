/**
 * @file run_real_java_audit.ts
 * Executes Sajimora unchanged against the 25-case real-world Java evaluation set.
 * Emits machine-readable per-consumer results and computes all audit metrics.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runJavaAnalysis, RunJavaAnalysisResult } from '../sajimora/analyzeJava';
import { RealJavaEvalCase, GroundTruthConsumer } from './generate_real_java_eval_set';

export interface AuditConsumerRow {
  caseId: string;
  repo: string;
  commitSha: string;
  changeType: string;
  javaVersion: number;
  buildSystem: string;
  consumerId: string;
  consumerFqcn: string;
  consumerFile: string;
  location: string;
  bindingKind: string;
  groundTruthSource: 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE';
  groundTruthBinary: 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE';
  groundTruthRuntime: string;
  isScopeComplete: boolean;

  // Sajimora outputs
  sajimoraDiscovered: boolean;
  sajimoraAdvisoryClassification: string;
  sajimoraSourceCandidate: string;
  sajimoraBinaryCandidate: string;
  sajimoraCertifiedVerdict: string;
  sajimoraEffectiveVerdict: string;
  qualificationStatus: string;
  primaryBlocker: string;
  blockerCodes: string[];
  proofId: string;
  elapsedMs: number;

  // Audit evaluation
  isDiscoveryMiss: boolean;
  isCorrectCertified: boolean;
  isUnsoundFP: boolean; // Confirmed False Positive: breaking in ground truth, certified COMPATIBLE
  isUnjustifiedCert: boolean; // Unjustified Certification: inconclusive in ground truth, certified COMPATIBLE
  isUnsoundNegative: boolean; // Unsound Negative: compatible in ground truth, branded INCOMPATIBLE
  isAbstention: boolean;
  auditEvaluation: 'CORRECT_CERTIFIED' | 'CORRECT_ADVISORY' | 'UNSOUND_FP' | 'UNJUSTIFIED_CERT' | 'UNSOUND_NEGATIVE' | 'SAFE_ABSTENTION' | 'DISCOVERY_MISS';
}

export interface AuditAggregateMetrics {
  totalCases: number;
  totalGroundTruthConsumers: number;
  discoveredConsumers: number;
  missedConsumers: number;
  consumerDiscoveryRecallPct: number;

  // Certification on discovered
  correctlyCertifiedDiscovered: number;
  certificationCoveragePct: number;

  // End-to-end consumer coverage
  correctlyCertifiedAll: number;
  endToEndConsumerCoveragePct: number;

  // API-change verdict coverage
  eligibleChanges: number;
  changesWithJustifiedVerdict: number;
  apiChangeVerdictCoveragePct: number;

  // Soundness errors
  confirmedFalsePositiveCount: number; // Definite breaking changes certified COMPATIBLE
  unjustifiedCertificationCount: number; // Inconclusive cases certified COMPATIBLE
  wrongIncompatibleCount: number; // Compatible consumers branded INCOMPATIBLE
  abstentionCount: number;

  // Slices
  byRepository: Record<string, any>;
  byChangeType: Record<string, any>;
  byJavaVersion: Record<string, any>;
  byBuildSystem: Record<string, any>;
  byCompatibilityType: Record<string, any>;
}

export function executeRealJavaAudit(): { rows: AuditConsumerRow[]; metrics: AuditAggregateMetrics } {
  const evalPath = path.resolve(__dirname, 'fixtures/real_java_api_changes_eval.json');
  const cases: RealJavaEvalCase[] = JSON.parse(fs.readFileSync(evalPath, 'utf8'));

  const rows: AuditConsumerRow[] = [];

  for (const c of cases) {
    const startTime = Date.now();

    const analysis: RunJavaAnalysisResult = runJavaAnalysis({
      repoId: c.caseId,
      historicalFiles: c.historicalFiles,
      candidateFiles: c.candidateFiles,
      format: 'json'
    });

    const elapsed = Date.now() - startTime;

    const qual = analysis.qualification;
    const certPanel = analysis.reportJson.certifiedPanel;
    const adv = analysis.advisoryResult;
    const blockers = qual.blockers.map(b => b.code);
    const primaryBlocker = blockers.length > 0 ? blockers[0] : 'NONE';

    for (const gtConsumer of c.groundTruthConsumers) {
      // 1. Check discovery in advisory consumers
      const discoveredRef = adv?.consumers.find(ref =>
        ref.consumerFqcn === gtConsumer.consumerFqcn ||
        ref.consumerFile === gtConsumer.consumerFile ||
        gtConsumer.consumerFile.endsWith(ref.consumerFile) ||
        ref.consumerFile.endsWith(gtConsumer.consumerFile)
      );

      const isDiscovered = Boolean(discoveredRef);

      // 2. Check advisory impact classification
      const impactRef = adv?.impacts.find(imp =>
        imp.consumerFqcn === gtConsumer.consumerFqcn ||
        imp.consumerFile === gtConsumer.consumerFile ||
        gtConsumer.consumerFile.endsWith(imp.consumerFile) ||
        imp.consumerFile.endsWith(gtConsumer.consumerFile)
      );

      const advisoryClassification = impactRef?.classification ?? (isDiscovered ? 'UNAFFECTED' : 'NOT_DISCOVERED');

      // 3. Certified status
      // Evaluate per-consumer certificate if available, falling back to repository qualification
      const consumerCert = analysis.consumerCertificates?.find(cert =>
        cert.consumerFqcn === gtConsumer.consumerFqcn ||
        cert.consumerFile === gtConsumer.consumerFile ||
        gtConsumer.consumerFile.endsWith(cert.consumerFile) ||
        cert.consumerFile.endsWith(gtConsumer.consumerFile)
      );

      const isQualified = qual.qualificationStatus === 'QUALIFIED_FOR_CERTIFIED_F0';
      const certifiedVerdict = consumerCert
        ? consumerCert.sourceVerifiedConclusion
        : (isQualified ? (certPanel.verifiedConclusion ?? 'UNCERTIFIED') : 'UNCERTIFIED');

      const effectiveVerdict = consumerCert
        ? (isQualified ? consumerCert.sourceCompatibility : 'INCONCLUSIVE')
        : (isQualified ? analysis.effectiveVerdict : 'INCONCLUSIVE');

      let isUnsoundFP = false;
      let isUnjustifiedCert = false;
      let isUnsoundNegative = false;
      let isCorrectCertified = false;
      let isAbstention = false;

      // Evaluate soundness against ground truth source compatibility
      if (gtConsumer.sourceCompatibility === 'INCOMPATIBLE') {
        if (effectiveVerdict === 'COMPATIBLE') {
          isUnsoundFP = true; // Confirmed False Positive: breaking in ground truth, certified COMPATIBLE!
        } else if (isDiscovered && certifiedVerdict === 'INCOMPATIBLE') {
          isCorrectCertified = true;
        } else {
          isAbstention = true;
        }
      } else if (gtConsumer.sourceCompatibility === 'COMPATIBLE') {
        if (effectiveVerdict === 'INCOMPATIBLE' || effectiveVerdict === 'LIKELY_VIOLATED') {
          isUnsoundNegative = true; // Unsound negative: compatible in ground truth, branded INCOMPATIBLE!
        } else if (isDiscovered && certifiedVerdict === 'COMPATIBLE') {
          isCorrectCertified = true;
        } else {
          isAbstention = true;
        }
      } else {
        // Ground truth is INCONCLUSIVE (e.g. external classpath missing)
        if (effectiveVerdict === 'COMPATIBLE') {
          isUnjustifiedCert = true; // Unjustified certification of incomplete analysis closure
        } else {
          isAbstention = true;
        }
      }

      let auditEvaluation: AuditConsumerRow['auditEvaluation'];
      if (!isDiscovered) {
        auditEvaluation = 'DISCOVERY_MISS';
      } else if (isUnsoundFP) {
        auditEvaluation = 'UNSOUND_FP';
      } else if (isUnjustifiedCert) {
        auditEvaluation = 'UNJUSTIFIED_CERT';
      } else if (isUnsoundNegative) {
        auditEvaluation = 'UNSOUND_NEGATIVE';
      } else if (isCorrectCertified) {
        auditEvaluation = 'CORRECT_CERTIFIED';
      } else if (isAbstention) {
        auditEvaluation = 'SAFE_ABSTENTION';
      } else {
        auditEvaluation = 'CORRECT_ADVISORY';
      }

      rows.push({
        caseId: c.caseId,
        repo: c.repo,
        commitSha: c.commitSha,
        changeType: c.changeType,
        javaVersion: c.javaVersion,
        buildSystem: c.buildSystem,
        consumerId: gtConsumer.consumerId,
        consumerFqcn: gtConsumer.consumerFqcn,
        consumerFile: gtConsumer.consumerFile,
        location: gtConsumer.location,
        bindingKind: gtConsumer.bindingKind,
        groundTruthSource: gtConsumer.sourceCompatibility,
        groundTruthBinary: gtConsumer.binaryCompatibility,
        groundTruthRuntime: gtConsumer.runtimeBehavior,
        isScopeComplete: gtConsumer.isScopeComplete,

        sajimoraDiscovered: isDiscovered,
        sajimoraAdvisoryClassification: advisoryClassification,
        sajimoraSourceCandidate: consumerCert?.sourceCompatibility ?? 'UNKNOWN',
        sajimoraBinaryCandidate: consumerCert?.binaryCompatibility ?? 'UNKNOWN',
        sajimoraCertifiedVerdict: certifiedVerdict,
        sajimoraEffectiveVerdict: effectiveVerdict,
        qualificationStatus: qual.qualificationStatus,
        primaryBlocker,
        blockerCodes: blockers,
        proofId: consumerCert?.obligations[0]?.obligationId ?? certPanel.obligationDigest ?? 'NONE',
        elapsedMs: elapsed,

        isDiscoveryMiss: !isDiscovered,
        isCorrectCertified,
        isUnsoundFP,
        isUnjustifiedCert,
        isUnsoundNegative,
        isAbstention,
        auditEvaluation
      });
    }
  }

  // Compute metrics
  const totalCases = cases.length;
  const totalGroundTruthConsumers = rows.length;
  const discoveredConsumers = rows.filter(r => r.sajimoraDiscovered).length;
  const missedConsumers = totalGroundTruthConsumers - discoveredConsumers;
  const consumerDiscoveryRecallPct = (discoveredConsumers / totalGroundTruthConsumers) * 100;

  const correctlyCertifiedDiscovered = rows.filter(r => r.sajimoraDiscovered && r.isCorrectCertified).length;
  const certificationCoveragePct = discoveredConsumers > 0 ? (correctlyCertifiedDiscovered / discoveredConsumers) * 100 : 0;

  // Sound accounting: A consumer missed by discovery CANNOT be counted as certified.
  const correctlyCertifiedAll = correctlyCertifiedDiscovered;
  const endToEndConsumerCoveragePct = (correctlyCertifiedAll / totalGroundTruthConsumers) * 100;

  // Case-level verdict coverage: changes with justified overall verdict / eligible changes
  // A verdict is justified if it does not produce an unsound FP, unjustified cert, or unsound negative
  const caseResults = cases.map(c => {
    const caseRows = rows.filter(r => r.caseId === c.caseId);
    const hasUnsoundFP = caseRows.some(r => r.isUnsoundFP);
    const hasUnjustifiedCert = caseRows.some(r => r.isUnjustifiedCert);
    const hasUnsoundNeg = caseRows.some(r => r.isUnsoundNegative);
    const hasMiss = caseRows.some(r => r.isDiscoveryMiss);
    const justified = !hasUnsoundFP && !hasUnjustifiedCert && !hasUnsoundNeg && !hasMiss;
    return { caseId: c.caseId, justified };
  });

  const eligibleChanges = totalCases;
  const changesWithJustifiedVerdict = caseResults.filter(cr => cr.justified).length;
  const apiChangeVerdictCoveragePct = (changesWithJustifiedVerdict / eligibleChanges) * 100;

  const confirmedFalsePositiveCount = rows.filter(r => r.isUnsoundFP).length;
  const unjustifiedCertificationCount = rows.filter(r => r.isUnjustifiedCert).length;
  const wrongIncompatibleCount = rows.filter(r => r.isUnsoundNegative).length;
  const abstentionCount = rows.filter(r => r.isAbstention).length;

  // Slices
  function computeSlice(groupByKey: keyof AuditConsumerRow): Record<string, any> {
    const groups: Record<string, { total: number; discovered: number; certified: number; unsoundFP: number; unsoundNeg: number; abstentions: number }> = {};
    for (const r of rows) {
      const key = String(r[groupByKey]);
      if (!groups[key]) {
        groups[key] = { total: 0, discovered: 0, certified: 0, unsoundFP: 0, unsoundNeg: 0, abstentions: 0 };
      }
      const g = groups[key];
      g.total++;
      if (r.sajimoraDiscovered) g.discovered++;
      if (r.isCorrectCertified) g.certified++;
      if (r.isUnsoundFP) g.unsoundFP++;
      if (r.isUnsoundNegative) g.unsoundNeg++;
      if (r.isAbstention) g.abstentions++;
    }
    return groups;
  }

  const byRepository = computeSlice('repo');
  const byChangeType = computeSlice('changeType');
  const byJavaVersion = computeSlice('javaVersion');
  const byBuildSystem = computeSlice('buildSystem');
  const byCompatibilityType = {
    sourceOnlyBreaking: rows.filter(r => r.groundTruthSource === 'INCOMPATIBLE' && r.groundTruthBinary === 'COMPATIBLE').length,
    binaryOnlyBreaking: rows.filter(r => r.groundTruthSource === 'COMPATIBLE' && r.groundTruthBinary === 'INCOMPATIBLE').length,
    bothBreaking: rows.filter(r => r.groundTruthSource === 'INCOMPATIBLE' && r.groundTruthBinary === 'INCOMPATIBLE').length,
    bothCompatible: rows.filter(r => r.groundTruthSource === 'COMPATIBLE' && r.groundTruthBinary === 'COMPATIBLE').length,
    runtimeBehavioralOnly: rows.filter(r => r.groundTruthSource === 'COMPATIBLE' && r.groundTruthBinary === 'COMPATIBLE' && r.groundTruthRuntime !== 'PRESERVED').length
  };

  const metrics: AuditAggregateMetrics = {
    totalCases,
    totalGroundTruthConsumers,
    discoveredConsumers,
    missedConsumers,
    consumerDiscoveryRecallPct: Math.round(consumerDiscoveryRecallPct * 10) / 10,
    correctlyCertifiedDiscovered,
    certificationCoveragePct: Math.round(certificationCoveragePct * 10) / 10,
    correctlyCertifiedAll,
    endToEndConsumerCoveragePct: Math.round(endToEndConsumerCoveragePct * 10) / 10,
    eligibleChanges,
    changesWithJustifiedVerdict,
    apiChangeVerdictCoveragePct: Math.round(apiChangeVerdictCoveragePct * 10) / 10,
    confirmedFalsePositiveCount,
    unjustifiedCertificationCount,
    wrongIncompatibleCount,
    abstentionCount,
    byRepository,
    byChangeType,
    byJavaVersion,
    byBuildSystem,
    byCompatibilityType
  };

  return { rows, metrics };
}

// Generate machine-readable artifacts
const { rows, metrics } = executeRealJavaAudit();

const artifactsDir = path.resolve(__dirname, '../../artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });

const resultsJsonPath = path.join(artifactsDir, 'real_java_audit_per_consumer_results.json');
fs.writeFileSync(resultsJsonPath, JSON.stringify({ metrics, rows }, null, 2), 'utf8');

const summaryJsonPath = path.join(artifactsDir, 'real_java_audit_summary.json');
fs.writeFileSync(summaryJsonPath, JSON.stringify(metrics, null, 2), 'utf8');

// Generate markdown table
const mdLines: string[] = [];
mdLines.push('# Machine-Readable Per-Consumer Audit Ledger');
mdLines.push(`**Evaluated API-Change Commit Pairs:** \`${metrics.totalCases}\` | **Ground-Truth Consumers:** \`${metrics.totalGroundTruthConsumers}\``);
mdLines.push('');
mdLines.push('| # | Case ID | Repository | Consumer ID | Location | Binding Kind | GT Source | GT Binary | Discovered? | Sajimora Effective | Sajimora Certified | Proof ID / Blocker | Evaluation | Elapsed |');
mdLines.push('|---|---|---|---|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|:---:|');

rows.forEach((r, idx) => {
  const evalBadge = r.auditEvaluation === 'CORRECT_CERTIFIED'
    ? '✅ CERTIFIED'
    : r.auditEvaluation === 'SAFE_ABSTENTION'
      ? '🟡 SAFE ABSTAIN'
      : r.auditEvaluation === 'UNSOUND_FP'
        ? '❌ UNSOUND FP'
        : r.auditEvaluation === 'UNJUSTIFIED_CERT'
          ? '⚠️ UNJUSTIFIED CERT'
          : r.auditEvaluation === 'UNSOUND_NEGATIVE'
            ? '❌ UNSOUND NEG'
            : r.auditEvaluation === 'DISCOVERY_MISS'
              ? '🔴 MISSED'
              : '⚪ ADVISORY';

  const proofOrBlocker = r.proofId !== 'NONE' ? `\`${r.proofId.slice(0, 10)}...\`` : (r.primaryBlocker !== 'NONE' ? `\`${r.primaryBlocker}\`` : '—');

  mdLines.push(
    `| ${idx + 1} | \`${r.caseId}\` | ${r.repo} | \`${r.consumerId}\` | \`${r.consumerFile}\` | \`${r.bindingKind}\` | \`${r.groundTruthSource}\` | \`${r.groundTruthBinary}\` | ${r.sajimoraDiscovered ? 'YES' : '**NO**'} | \`${r.sajimoraEffectiveVerdict}\` | \`${r.sajimoraCertifiedVerdict}\` | ${proofOrBlocker} | ${evalBadge} | ${r.elapsedMs}ms |`
  );
});

const mdTablePath = path.join(artifactsDir, 'real_java_audit_per_consumer_table.md');
fs.writeFileSync(mdTablePath, mdLines.join('\n'), 'utf8');

console.log(`Generated audit artifacts:`);
console.log(`- JSON: ${resultsJsonPath}`);
console.log(`- Summary: ${summaryJsonPath}`);
console.log(`- Markdown: ${mdTablePath}`);
console.log('\n--- AUDIT METRICS ---');
console.log(JSON.stringify(metrics, null, 2));
