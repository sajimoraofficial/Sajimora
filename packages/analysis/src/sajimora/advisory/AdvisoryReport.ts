import { AdvisoryDiagnostic, AdvisoryImpactTrace } from './TypeScriptImpactAnalyzer';
import { ReconciledImpactResult } from './ReconcileAdvisoryResult';

export interface AdvisoryReport {
  schemaVersion: 'ADVISORY_REPORT_V1';
  certifiedPanel: { verdict: ReconciledImpactResult['final']['verdict']; reason: string; conflict: ReconciledImpactResult['final']['conflict']; };
  broaderImpactPanel: { verdict: ReconciledImpactResult['advisory']['verdict']; confidence: 'HIGH' | 'LIMITED'; consumersAffected: number; consumersAnalyzed: number; unresolvedDependencies: number; };
  evidence: { parentCommitSha: string; candidateCommitSha: string; compilerVersion: string; compilerOptions: Record<string, unknown>; providers: ReconciledImpactResult['advisory']['providers']; traces: readonly AdvisoryImpactTrace[]; diagnostics: readonly AdvisoryDiagnostic[]; unresolvedDependencies: readonly string[]; resolutionTraces: readonly string[]; selection: ReconciledImpactResult['advisory']['completeness']['selection']; };
}

export function createAdvisoryReport(result: ReconciledImpactResult): AdvisoryReport {
  const advisory = result.advisory; const diagnostics = advisory.traces.flatMap(trace => trace.diagnostics).sort((a, b) => { const ja = JSON.stringify(a); const jb = JSON.stringify(b); return ja < jb ? -1 : ja > jb ? 1 : 0; });
  return {
    schemaVersion: 'ADVISORY_REPORT_V1',
    certifiedPanel: { verdict: result.final.verdict, reason: result.final.conflict?.reason ?? result.certified.reason, conflict: result.final.conflict },
    broaderImpactPanel: { verdict: advisory.verdict, confidence: advisory.completeness.status === 'COMPLETE' ? 'HIGH' : 'LIMITED', consumersAffected: advisory.impacts.filter(impact => impact.classification === 'NEWLY_FAILING').length, consumersAnalyzed: advisory.completeness.consumersAnalyzed, unresolvedDependencies: advisory.completeness.unresolvedDependencyCount },
    evidence: { parentCommitSha: advisory.parentCommitSha, candidateCommitSha: advisory.candidateCommitSha, compilerVersion: advisory.compilerVersion, compilerOptions: advisory.compilerOptions, providers: advisory.providers, traces: advisory.traces, diagnostics, unresolvedDependencies: advisory.completeness.unresolvedFiles, resolutionTraces: advisory.completeness.resolutionTraces, selection: advisory.completeness.selection }
  };
}

/** Stable, human-readable rendering; the structured report carries expandable evidence. */
export function renderAdvisoryMarkdown(report: AdvisoryReport): string {
  const lines = [
    '## Certified result', '', `Certified verdict: ${report.certifiedPanel.verdict}`, `Reason: ${report.certifiedPanel.reason}`,
    '', '## Broader impact analysis', '', `Advisory result: ${report.broaderImpactPanel.verdict}`, `Confidence: ${report.broaderImpactPanel.confidence}`,
    `Consumers affected: ${report.broaderImpactPanel.consumersAffected}`, `Consumers analyzed: ${report.broaderImpactPanel.consumersAnalyzed}`, `Unresolved dependencies: ${report.broaderImpactPanel.unresolvedDependencies}`
  ];
  for (const trace of report.evidence.traces) { lines.push('', `### ${trace.providerId}`, ...trace.steps.map(step => `- ${step.kind}: ${step.file}${step.span ? `:${step.span.line}:${step.span.column}` : ''} — ${step.detail}`)); }
  return lines.join('\n');
}
