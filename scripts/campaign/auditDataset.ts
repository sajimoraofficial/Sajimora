import * as fs from 'fs';
import * as path from 'path';
import { deriveRealDiffObligations } from './realDiffObligationAdapter';

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

const root = process.cwd();
const rows: any[] = [];
for (const repository of ['turborepo', 'TypeScript-Website', 'express', 'zod']) {
  const labels = JSON.parse(fs.readFileSync(path.join(root, 'scripts/campaign/labels', `${repository}.json`), 'utf8'));
  for (const label of labels) {
    const derived = deriveRealDiffObligations(path.join(root, 'scripts/campaign/repos', repository), label.parentSha, label.commitSha);
    const obligations = derived.status === 'DERIVED' ? derived.obligations : [];
    const matches = obligations.filter((item: any) => item.mutatedSymbol?.qualifiedName === label.targetSymbol && item.mutatedSymbol?.declarationLocation.filePath.endsWith(`/${label.targetFile}`));
    const classification = derived.status !== 'DERIVED' ? 'MISSING_REAL_MUTATION'
      : matches.length === 0 ? 'INVALID_LEGACY_CASE'
      : matches.length > 1 ? 'AMBIGUOUS_TARGET'
      : 'LABEL_REQUIRES_REVALIDATION';
    rows.push({
      caseId: `${repository}:${label.commitSha.slice(0, 7)}`, repository, parentSha: label.parentSha, candidateSha: label.commitSha,
      originalTarget: { symbol: label.targetSymbol, file: label.targetFile }, originalLabel: label.expectedVerdict,
      changedFiles: derived.changedFiles, actualDiff: derived.actualDiff,
      changedDeclarations: obligations.map((item: any) => ({ target: item.mutatedSymbol, mutation: item.providerMutation, before: item.providerContracts?.before, after: item.providerContracts?.after })),
      targetMatches: matches.map((item: any) => ({ target: item.mutatedSymbol, mutation: item.providerMutation, before: item.providerContracts?.before, after: item.providerContracts?.after })),
      mapping: { classification: matches.length === 1 ? 'UNIQUE' : matches.length > 1 ? 'AMBIGUOUS' : 'NONE', reason: derived.status === 'DERIVED' ? `Frozen target matched ${matches.length} changed declaration(s).` : derived.reason },
      classification,
      reason: classification === 'LABEL_REQUIRES_REVALIDATION' ? 'A unique real mutation exists, but the frozen PRESERVED label is not independently justified by diff evidence alone.' : (derived.status === 'DERIVED' ? 'Frozen target is not grounded in exactly one changed declaration.' : derived.reason)
    });
  }
}
rows.sort((a, b) => a.caseId.localeCompare(b.caseId));
const artifact = canonical({ schemaVersion: 'V32.9-TS-dataset-integrity-v1', rows });
const output = process.argv[2];
if (!output) throw new Error('output path required');
fs.writeFileSync(output, JSON.stringify(artifact, null, 2) + '\n');
