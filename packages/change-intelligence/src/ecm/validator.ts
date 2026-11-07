/**
 * SAJIMORA V32 — Expected Change Model (ECM) Validator
 * Subordinate to sajimora_v32_foundation_spec.md §1.3 & §1.4.
 *
 * Enforces rules ECM-R1 through ECM-R8.
 */

import * as crypto from 'crypto';
import {
  ExpectedChangeModel,
  ExpectedFileChange,
  ExpectedSymbolChange,
  ExpectedEdgeChange,
  ExpectedBehavioralObligation,
  ExpectedInvariantTransition,
  ChangeBoundary,
  EcmSource,
} from '../types';

export interface RawEcmParams {
  workspaceId: string;
  baseCommitSha: string;
  candidateCommitSha: string;
  ecmSource?: EcmSource;
  expectedFiles?: ExpectedFileChange[];
  expectedSymbols?: ExpectedSymbolChange[];
  expectedEdges?: ExpectedEdgeChange[];
  expectedBehavioralObligations?: ExpectedBehavioralObligation[];
  expectedInvariantTransitions?: ExpectedInvariantTransition[];
  changeBoundary?: ChangeBoundary | null;
}

/**
 * Normalizes a file path to workspace-relative POSIX format.
 * Returns null if the path contains traversal segments ("..") or invalid formatting.
 * ECM-R2.
 */
export function normalizePosixPath(rawPath: string): string | null {
  if (!rawPath || typeof rawPath !== 'string') return null;
  // Convert Windows backslashes to forward slashes
  let normalized = rawPath.replace(/\\/g, '/').trim();

  // Strip leading slash if present
  if (normalized.startsWith('/')) {
    normalized = normalized.substring(1);
  }

  // Reject path traversal
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      return null;
    }
  }

  // Filter out empty segments or dot segments
  const cleanSegments = segments.filter((s) => s.length > 0 && s !== '.');
  if (cleanSegments.length === 0) return null;

  return cleanSegments.join('/');
}

/**
 * Checks whether a given target path violates a forbidden boundary path.
 * ECM-R5: Exact prefix match only.
 * Path P violates boundary B iff P === B or P.startsWith(B + "/").
 */
export function isPathBoundaryViolated(targetPath: string, forbiddenPrefix: string): boolean {
  const normTarget = normalizePosixPath(targetPath);
  const normForbidden = normalizePosixPath(forbiddenPrefix);
  if (!normTarget || !normForbidden) return false;

  return normTarget === normForbidden || normTarget.startsWith(`${normForbidden}/`);
}

/**
 * Computes deterministic ChangeId: hex(SHA-256(workspaceId:baseCommitSha:candidateCommitSha)).
 * ECM-R1.
 */
export function computeChangeId(workspaceId: string, baseCommitSha: string, candidateCommitSha: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(`${workspaceId}:${baseCommitSha}:${candidateCommitSha}`);
  return hash.digest('hex');
}

/**
 * Validates raw ECM parameters and constructs a validated, immutable ExpectedChangeModel.
 * Fails closed on missing mandatory identities (workspaceId, baseCommitSha, candidateCommitSha).
 */
export function validateAndBuildEcm(params: RawEcmParams): ExpectedChangeModel {
  const validationErrors: string[] = [];

  // Mandatory identity checks (§1.4)
  if (!params.workspaceId || typeof params.workspaceId !== 'string' || params.workspaceId.trim().length === 0) {
    throw new Error('HARD_VALIDATION_ERROR: workspaceId is mandatory and cannot be empty.');
  }
  if (!params.baseCommitSha || typeof params.baseCommitSha !== 'string' || params.baseCommitSha.trim().length === 0) {
    throw new Error('HARD_VALIDATION_ERROR: baseCommitSha is mandatory and cannot be empty.');
  }
  if (!params.candidateCommitSha || typeof params.candidateCommitSha !== 'string' || params.candidateCommitSha.trim().length === 0) {
    throw new Error('HARD_VALIDATION_ERROR: candidateCommitSha is mandatory for V32 ECM creation (ECM-R1 / OQ-4).');
  }

  const workspaceId = params.workspaceId.trim();
  const baseCommitSha = params.baseCommitSha.trim();
  const candidateCommitSha = params.candidateCommitSha.trim();
  const changeId = computeChangeId(workspaceId, baseCommitSha, candidateCommitSha);
  const ecmSource: EcmSource = params.ecmSource || 'STRUCTURED_INPUT';

  // 1. Process and normalize expectedFiles (ECM-R2, ECM-R6)
  const expectedFiles: ExpectedFileChange[] = [];
  const confidences: number[] = [];

  for (const f of params.expectedFiles || []) {
    const normPath = normalizePosixPath(f.filePath);
    if (!normPath) {
      validationErrors.push(`ExpectedFileChange dropped: path "${f.filePath}" failed normalization or attempted traversal.`);
      continue;
    }
    let normOldPath: string | undefined;
    if (f.oldFilePath) {
      const p = normalizePosixPath(f.oldFilePath);
      if (p) normOldPath = p;
    }

    let conf = Math.max(0.0, Math.min(1.0, f.confidence ?? 1.0));
    if (f.provenance === 'UNKNOWN' && conf > 0.3) {
      conf = 0.3; // ECM-R6
    }
    confidences.push(conf);

    expectedFiles.push({
      filePath: normPath,
      changeType: f.changeType,
      oldFilePath: normOldPath,
      provenance: f.provenance,
      confidence: conf,
    });
  }

  // 2. Process and normalize expectedSymbols (ECM-R2, ECM-R6)
  const expectedSymbols: ExpectedSymbolChange[] = [];
  for (const s of params.expectedSymbols || []) {
    const normPath = normalizePosixPath(s.filePath);
    if (!normPath) {
      validationErrors.push(`ExpectedSymbolChange dropped: path "${s.filePath}" failed normalization.`);
      continue;
    }
    let conf = Math.max(0.0, Math.min(1.0, s.confidence ?? 1.0));
    if (s.provenance === 'UNKNOWN' && conf > 0.3) {
      conf = 0.3;
    }
    confidences.push(conf);

    expectedSymbols.push({
      filePath: normPath,
      symbolName: s.symbolName.trim(),
      symbolKind: s.symbolKind || 'OTHER',
      changeType: s.changeType,
      oldSymbolName: s.oldSymbolName?.trim(),
      oldSignature: s.oldSignature?.trim(),
      newSignature: s.newSignature?.trim(),
      provenance: s.provenance,
      confidence: conf,
    });
  }

  // 3. Process expectedEdges (ECM-R2, ECM-R6)
  const expectedEdges: ExpectedEdgeChange[] = [];
  for (const e of params.expectedEdges || []) {
    const normSource = normalizePosixPath(e.sourceFilePath);
    const normTarget = normalizePosixPath(e.targetFilePath);
    if (!normSource || !normTarget) {
      validationErrors.push(`ExpectedEdgeChange dropped: source or target path failed normalization.`);
      continue;
    }
    let conf = Math.max(0.0, Math.min(1.0, e.confidence ?? 1.0));
    if (e.provenance === 'UNKNOWN' && conf > 0.3) {
      conf = 0.3;
    }
    confidences.push(conf);

    expectedEdges.push({
      sourceFilePath: normSource,
      targetFilePath: normTarget,
      edgeKind: e.edgeKind,
      changeType: e.changeType,
      provenance: e.provenance,
      confidence: conf,
    });
  }

  // 4. Process expectedBehavioralObligations (ECM-R6)
  const expectedBehavioralObligations: ExpectedBehavioralObligation[] = [];
  for (const b of params.expectedBehavioralObligations || []) {
    let conf = Math.max(0.0, Math.min(1.0, b.confidence ?? 1.0));
    if (b.provenance === 'UNKNOWN' && conf > 0.3) {
      conf = 0.3;
    }
    confidences.push(conf);

    expectedBehavioralObligations.push({
      obligationId: b.obligationId.trim(),
      description: b.description.trim(),
      verificationStrategy: b.verificationStrategy,
      targetEntities: b.targetEntities || [],
      contentHints: b.contentHints || [],
      provenance: b.provenance,
      confidence: conf,
    });
  }

  // 5. Process expectedInvariantTransitions (ECM-R6)
  const expectedInvariantTransitions: ExpectedInvariantTransition[] = [];
  for (const inv of params.expectedInvariantTransitions || []) {
    let conf = Math.max(0.0, Math.min(1.0, inv.confidence ?? 1.0));
    if (inv.provenance === 'UNKNOWN' && conf > 0.3) {
      conf = 0.3;
    }
    confidences.push(conf);

    expectedInvariantTransitions.push({
      invariantDescription: inv.invariantDescription.trim(),
      expectedState: inv.expectedState,
      evolutionReason: inv.evolutionReason?.trim(),
      provenance: inv.provenance,
      confidence: conf,
    });
  }

  // 6. Process changeBoundary (ECM-R5)
  let changeBoundary: ChangeBoundary | null = null;
  if (params.changeBoundary && params.changeBoundary.forbiddenPaths && params.changeBoundary.forbiddenPaths.length > 0) {
    const validForbidden: string[] = [];
    for (const p of params.changeBoundary.forbiddenPaths) {
      const norm = normalizePosixPath(p);
      if (norm) validForbidden.push(norm);
    }
    changeBoundary = {
      forbiddenPaths: validForbidden,
      reason: params.changeBoundary.reason.trim(),
      provenance: params.changeBoundary.provenance || 'DEVELOPER_DECLARED',
    };
  }

  // 7. Calculate overallConfidence (ECM-R3, ECM-R4)
  const totalExpectationCount =
    expectedFiles.length +
    expectedSymbols.length +
    expectedEdges.length +
    expectedBehavioralObligations.length +
    expectedInvariantTransitions.length;

  let overallConfidence = 0.0;
  let validationStatus: 'VALID' | 'INVALID' | 'PARTIAL' = 'VALID';

  if (totalExpectationCount === 0) {
    // ECM-R4: All expectation arrays empty -> PARTIAL, overallConfidence = 0.0
    overallConfidence = 0.0;
    validationStatus = 'PARTIAL';
    validationErrors.push('ECM contains zero expectations across all categories (honest absence).');
  } else {
    const sum = confidences.reduce((a, b) => a + b, 0);
    overallConfidence = sum / confidences.length;

    // Cap at 0.5 when ecmSource is INFERRED (ECM-R3)
    if (ecmSource === 'INFERRED') {
      overallConfidence = Math.min(0.5, overallConfidence);
    }

    // Clamp [0.0, 1.0]
    overallConfidence = Math.max(0.0, Math.min(1.0, overallConfidence));

    if (overallConfidence < 0.2) {
      validationStatus = 'PARTIAL';
      validationErrors.push(`overallConfidence (${overallConfidence.toFixed(4)}) is below 0.2 threshold.`);
    }
  }

  return {
    changeId,
    workspaceId,
    baseCommitSha,
    candidateCommitSha,
    createdAt: new Date(),
    ecmSource,
    expectedFiles,
    expectedSymbols,
    expectedEdges,
    expectedBehavioralObligations,
    expectedInvariantTransitions,
    changeBoundary,
    overallConfidence: Number(overallConfidence.toFixed(4)),
    validationStatus,
    validationErrors,
  };
}
