/**
 * AgentImpactJson.ts
 *
 * Validates, sorts, redacts, and serializes the CrossLanguageImpactReport to
 * stable, deterministic JSON suitable for machine consumption by coding agents.
 *
 * Rules:
 *  - stdout contains exactly one JSON object; logs go to stderr.
 *  - Arrays in the output are sorted deterministically.
 *  - No credentials, auth headers, real traffic response bodies, absolute temp
 *    paths, or entire source files appear in the output.
 *  - Snippet lengths are capped.
 *  - Schema version and assurance fields are always present.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { binaryCompare } from '@sajimora/core';
import {
  CrossLanguageImpactReport,
  CrossLanguageFinding,
  AnalysisBlocker,
  isCrossLanguageImpactReport,
} from './CrossLanguageContracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_USAGE_SNIPPET_LEN = 200;
const MAX_REPAIR_HINT_LEN = 500;
const MAX_BLOCKER_MSG_LEN = 300;

// Known secret patterns to redact from string values (best-effort).
const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /password\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
];

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  return out;
}

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

// ---------------------------------------------------------------------------
// Sorting helpers
// ---------------------------------------------------------------------------

function sortFindings(findings: readonly CrossLanguageFinding[]): CrossLanguageFinding[] {
  return [...findings].sort((a, b) => {
    const ep = binaryCompare(a.endpoint.path, b.endpoint.path);
    if (ep !== 0) return ep;
    const wp = binaryCompare(a.wirePath, b.wirePath);
    if (wp !== 0) return wp;
    return binaryCompare(a.id, b.id);
  }).map(f => ({
    ...f,
    consumers: [...f.consumers].sort((a, b) => binaryCompare(a.file, b.file) || a.line - b.line),
    evidence: [...f.evidence].sort((a, b) => binaryCompare(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0)),
  }));
}

function sortBlockers(blockers: readonly AnalysisBlocker[]): AnalysisBlocker[] {
  return [...blockers].sort((a, b) => {
    const c = binaryCompare(a.code, b.code);
    if (c !== 0) return c;
    return binaryCompare(a.message, b.message);
  });
}

// ---------------------------------------------------------------------------
// Sanitize
// ---------------------------------------------------------------------------

function sanitizeFinding(f: CrossLanguageFinding): CrossLanguageFinding {
  return {
    ...f,
    repairHint: cap(redactSecrets(f.repairHint), MAX_REPAIR_HINT_LEN),
    consumers: f.consumers.map(c => ({
      ...c,
      usage: cap(redactSecrets(c.usage), MAX_USAGE_SNIPPET_LEN),
    })),
    typescriptClient: {
      ...f.typescriptClient,
      expectation: cap(redactSecrets(f.typescriptClient.expectation), MAX_USAGE_SNIPPET_LEN),
    },
  };
}

function sanitizeBlocker(b: AnalysisBlocker): AnalysisBlocker {
  return {
    ...b,
    message: cap(redactSecrets(b.message), MAX_BLOCKER_MSG_LEN),
  };
}

// ---------------------------------------------------------------------------
// Main serialiser
// ---------------------------------------------------------------------------

/**
 * Produce a stable, deterministic JSON string from a CrossLanguageImpactReport.
 * Sorts all arrays, caps snippets, and redacts known secret patterns.
 */
export function serializeReport(report: CrossLanguageImpactReport): string {
  const sanitized: CrossLanguageImpactReport = {
    ...report,
    findings: sortFindings(report.findings.map(sanitizeFinding)),
    blockers: sortBlockers(report.blockers.map(sanitizeBlocker)),
    ...(report.scopedChanges?{scopedChanges:{...report.scopedChanges,
      assessments:[...report.scopedChanges.assessments].sort((a,b)=>binaryCompare(a.obligationId, b.obligationId)).map(a=>({...a,consumers:a.consumers.map(c=>({...c,usage:cap(redactSecrets(c.usage),MAX_USAGE_SNIPPET_LEN)})),...(a.conditionalFindings?{conditionalFindings:a.conditionalFindings.map(f=>({...f,consumer:{...f.consumer,usage:cap(redactSecrets(f.consumer.usage),MAX_USAGE_SNIPPET_LEN)}}))}:{}),missingEvidence:a.missingEvidence.map(s=>cap(redactSecrets(s),MAX_BLOCKER_MSG_LEN)),...(a.witness?{witness:{...a.witness,reason:cap(redactSecrets(a.witness.reason),MAX_REPAIR_HINT_LEN)}}:{})})),
      evidenceRequests:report.scopedChanges.evidenceRequests.map(r=>({...r,reason:cap(redactSecrets(r.reason),MAX_BLOCKER_MSG_LEN),...(r.affectedConsumers?{affectedConsumers:r.affectedConsumers.map(c=>({...c,usage:cap(redactSecrets(c.usage),MAX_USAGE_SNIPPET_LEN)}))}:{})}))}}:{}),
    ...(report.delta ? {delta:{newFindings:sortFindings(report.delta.newFindings.map(sanitizeFinding)),existingFindings:sortFindings(report.delta.existingFindings.map(sanitizeFinding)),resolvedFindings:sortFindings(report.delta.resolvedFindings.map(sanitizeFinding))}} : {}),
  };
  return JSON.stringify(sanitized, null, 2);
}

/**
 * Write the report to a file atomically (write to a temp file, then rename)
 * to avoid agents reading a partially written file.
 */
export function writeReportAtomic(
  report: CrossLanguageImpactReport,
  outputPath: string
): void {
  const json = serializeReport(report);
  const dir = path.dirname(path.resolve(outputPath));
  // Write to a temp file in the same directory so rename is atomic.
  const tmp = path.join(dir, `.sajimora-tmp-${createHash('sha256').update(json).digest('hex').slice(0, 8)}.json`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, json, { encoding: 'utf8', flag: 'w' });
  fs.renameSync(tmp, outputPath);
}

/**
 * Parse and validate a JSON string as a CrossLanguageImpactReport.
 * Throws if the JSON is malformed or fails the type-guard.
 */
export function parseReport(json: string): CrossLanguageImpactReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`CrossLanguageImpactReport: JSON parse error: ${(err as Error).message}`);
  }
  if (!isCrossLanguageImpactReport(parsed)) {
    throw new Error(
      `CrossLanguageImpactReport: JSON does not match expected schema. ` +
      `Expected schemaVersion="${'SAJIMORA_CROSS_LANGUAGE_IMPACT_V1'}", assurance="ADVISORY_ONLY".`
    );
  }
  return parsed;
}

/**
 * Content-hash fingerprint of a serialized report (for determinism checks).
 */
export function reportFingerprint(report: CrossLanguageImpactReport): string {
  return createHash('sha256').update(serializeReport(report)).digest('hex').slice(0, 16);
}
