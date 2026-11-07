import { createHash } from 'crypto';
import * as path from 'path';
import ts from 'typescript';
import { GenericRepository, GenericRepositorySnapshot } from '../../packages/core/src/sajimora/verification';
import { canonicalRepositoryPath } from '../../packages/analysis/src/sajimora/languages/typescript/production/CanonicalRepositoryPath';
import { CoverageQuery } from './coverage_types';

const VERDICTS = new Set(['PRESERVED', 'VIOLATED', 'UNKNOWN', 'NOT_APPLICABLE']);
const LEVELS = new Set(['L1_SINGLE', 'L2_PAIRWISE', 'L3_THREE_WAY', 'L4_FOUR_WAY', 'L5_HIGH_RISK']);

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  uniqueIds: number;
  duplicatePayloadGroups: string[][];
  unchangedSnapshotIds: string[];
  querySetDigest: string;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableFiles(files: Record<string, string>): Array<[string, string]> {
  return Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
}

export function querySetDigest(queries: readonly CoverageQuery[]): string {
  return sha256(JSON.stringify(queries.map(q => ({
    id: q.id,
    expectedVerdict: q.expectedVerdict,
    parentFiles: stableFiles(q.parentFiles),
    candidateFiles: stableFiles(q.candidateFiles)
  }))));
}

export function exactVerdictMatch(expected: string, actual: string): boolean {
  return expected === actual;
}

function scriptKind(filePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.json$/i.test(filePath)) return ts.ScriptKind.JSON;
  if (/\.(js|mjs|cjs)$/i.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function validateFiles(query: CoverageQuery, side: 'parent' | 'candidate', files: Record<string, string>, errors: string[]): void {
  const seen = new Set<string>();
  for (const [filePath, content] of Object.entries(files)) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!filePath || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      errors.push(`${query.id}: ${side} contains unsafe virtual path ${JSON.stringify(filePath)}`);
    }
    const folded = normalized.toLowerCase();
    if (seen.has(folded)) errors.push(`${query.id}: ${side} contains case-colliding path ${filePath}`);
    seen.add(folded);
    if (typeof content !== 'string') {
      errors.push(`${query.id}: ${side} file ${filePath} is not text`);
      continue;
    }
    if (/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/i.test(filePath)) {
      const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind(filePath));
      const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
      for (const diagnostic of diagnostics) {
        const position = diagnostic.start === undefined ? '' : ` at ${diagnostic.start}`;
        errors.push(`${query.id}: ${side}/${filePath}${position}: TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
      }
    } else if (/\.json$/i.test(filePath)) {
      const parsed = ts.parseConfigFileTextToJson(filePath, content);
      if (parsed.error) errors.push(`${query.id}: ${side}/${filePath}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`);
    }
  }
}

export function validateQueries(queries: readonly CoverageQuery[], expectedTotal?: number): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const payloads = new Map<string, string[]>();
  const unchangedSnapshotIds: string[] = [];

  if (expectedTotal !== undefined && queries.length !== expectedTotal) {
    errors.push(`Expected ${expectedTotal} queries but received ${queries.length}`);
  }
  for (const query of queries) {
    if (!query.id?.trim()) errors.push('Query has an empty id');
    else if (ids.has(query.id)) errors.push(`Duplicate query id ${query.id}`);
    ids.add(query.id);
    if (!Number.isInteger(query.tier) || query.tier < 1 || query.tier > 6) errors.push(`${query.id}: invalid tier ${query.tier}`);
    if (!LEVELS.has(query.level)) errors.push(`${query.id}: invalid level ${query.level}`);
    if (!VERDICTS.has(query.expectedVerdict)) errors.push(`${query.id}: invalid expected verdict ${query.expectedVerdict}`);
    if (!query.family?.trim()) errors.push(`${query.id}: empty family`);
    if (!query.description?.trim()) errors.push(`${query.id}: empty description`);
    if (!Array.isArray(query.features) || query.features.length === 0) errors.push(`${query.id}: features must be non-empty`);
    if (!query.parentFiles || typeof query.parentFiles !== 'object') errors.push(`${query.id}: missing parentFiles`);
    if (!query.candidateFiles || typeof query.candidateFiles !== 'object') errors.push(`${query.id}: missing candidateFiles`);
    validateFiles(query, 'parent', query.parentFiles || {}, errors);
    validateFiles(query, 'candidate', query.candidateFiles || {}, errors);

    const parent = JSON.stringify(stableFiles(query.parentFiles || {}));
    const candidate = JSON.stringify(stableFiles(query.candidateFiles || {}));
    if (parent === candidate) unchangedSnapshotIds.push(query.id);
    const payload = sha256(JSON.stringify([parent, candidate, query.expectedVerdict]));
    const group = payloads.get(payload) || [];
    group.push(query.id);
    payloads.set(payload, group);
  }
  const duplicatePayloadGroups = [...payloads.values()].filter(group => group.length > 1);
  if (duplicatePayloadGroups.length) warnings.push(`${duplicatePayloadGroups.length} duplicate payload groups cover ${duplicatePayloadGroups.reduce((n, g) => n + g.length, 0)} queries`);
  if (unchangedSnapshotIds.length) warnings.push(`${unchangedSnapshotIds.length} queries have byte-identical parent and candidate snapshots`);
  return { valid: errors.length === 0, errors, warnings, uniqueIds: ids.size, duplicatePayloadGroups, unchangedSnapshotIds, querySetDigest: querySetDigest(queries) };
}

export function buildRepository(id: string, parentFiles: Record<string, string>, candidateFiles: Record<string, string>): GenericRepository {
  const makeSnapshot = (side: string, files: Record<string, string>): GenericRepositorySnapshot => {
    const entries = stableFiles(files);
    const filesDigest = sha256(JSON.stringify(entries));
    const normalizedFileMap = new Map<string, string>();
    for (const [filePath, content] of entries) {
      normalizedFileMap.set(canonicalRepositoryPath(filePath), content);
    }
    return {
      snapshotId: `${side}_${id}_${filesDigest.slice(0, 16)}`,
      rootIdentifier: '/',
      files: entries.map(([filePath, content]) => ({ path: canonicalRepositoryPath(filePath), byteLength: Buffer.byteLength(content, 'utf8'), hash: sha256(content) })),
      readTextFile: filePath => normalizedFileMap.get(canonicalRepositoryPath(filePath)),
      readBinaryFile: filePath => {
        const text = normalizedFileMap.get(canonicalRepositoryPath(filePath));
        return text === undefined ? undefined : Buffer.from(text, 'utf8');
      }
    };
  };
  return { repositoryId: id, parentSnapshot: makeSnapshot('parent', parentFiles), candidateSnapshot: makeSnapshot('candidate', candidateFiles) };
}

export function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}
