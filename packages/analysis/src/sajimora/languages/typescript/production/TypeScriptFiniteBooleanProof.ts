import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { EvidenceChecker, GenericRepository, GenericRepositorySnapshot,
  VerificationObligation, VerificationVerdict } from '../../../../../../core/src/sajimora/verification';

export const TS_FINITE_BOOLEAN_BEHAVIOR_V1 = 'TS_FINITE_BOOLEAN_BEHAVIOR_V1';
const parserDistributionDigest = (() => {
  try {
    return createHash('sha256').update(readFileSync(require.resolve('typescript'))).digest('hex');
  } catch {
    // When executing from a bundled standalone distribution without physical node_modules/typescript on disk,
    // fallback to deterministic version-bound hash:
    return createHash('sha256').update(`typescript@${ts.version}:bundled`).digest('hex');
  }
})();

export type FiniteBooleanModel = { readonly parameterCount: number; readonly outputs: readonly boolean[];
  readonly sourceHash: string; readonly declarationLine: number };

/** Fully consume a pure Boolean function whose finite domain has at most 256
 * inputs. This models only the admitted TypeScript expression fragment. */
export function readFiniteBooleanModel(snapshot: GenericRepositorySnapshot, file: string, name: string): FiniteBooleanModel | undefined {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts') || file.includes('\\') ||
      file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  const entries = snapshot.files.filter(entry => entry.path === file);
  if (entries.length !== 1 || entries[0].isSymlink || entries[0].byteLength > 256_000) return undefined;
  const source = snapshot.readTextFile(file);
  if (source === undefined) return undefined;
  const bytes = Buffer.from(source, 'utf8');
  const binary = snapshot.readBinaryFile(file);
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== entries[0].byteLength || sourceHash !== entries[0].hash ||
      (binary !== undefined && !bytes.equals(Buffer.from(binary)))) return undefined;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length ||
      sf.statements.length !== 1 || !ts.isFunctionDeclaration(sf.statements[0])) return undefined;
  const fn = sf.statements[0];
  if (fn.name?.text !== name || !fn.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword) ||
      fn.modifiers.some(mod => mod.kind !== ts.SyntaxKind.ExportKeyword) || fn.asteriskToken ||
      fn.typeParameters?.length || fn.type?.kind !== ts.SyntaxKind.BooleanKeyword ||
      !fn.body || fn.body.statements.length !== 1 || !ts.isReturnStatement(fn.body.statements[0]) ||
      !fn.body.statements[0].expression || fn.parameters.length > 8) return undefined;
  const names: string[] = [];
  for (const parameter of fn.parameters) {
    if (!ts.isIdentifier(parameter.name) || parameter.type?.kind !== ts.SyntaxKind.BooleanKeyword ||
        parameter.initializer || parameter.questionToken || parameter.dotDotDotToken || parameter.modifiers?.length ||
        parameter.name.text === 'this' || names.includes(parameter.name.text)) return undefined;
    names.push(parameter.name.text);
  }
  const expression = fn.body.statements[0].expression;
  const validExpression = (node: ts.Expression, depth: number): boolean => {
    if (depth > 128) return false;
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true;
    if (ts.isIdentifier(node)) return names.includes(node.text);
    if (ts.isParenthesizedExpression(node)) return validExpression(node.expression, depth + 1);
    if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.ExclamationToken &&
      validExpression(node.operand, depth + 1);
    if (ts.isBinaryExpression(node)) return [ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind) &&
      validExpression(node.left, depth + 1) && validExpression(node.right, depth + 1);
    if (ts.isConditionalExpression(node)) return validExpression(node.condition, depth + 1) &&
      validExpression(node.whenTrue, depth + 1) && validExpression(node.whenFalse, depth + 1);
    return false;
  };
  if (!validExpression(expression, 0)) return undefined;
  const evaluate = (node: ts.Expression, values: readonly boolean[], depth: number): boolean => {
    if (depth > 128) throw new Error('EXPRESSION_BUDGET');
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node)) {
      const index = names.indexOf(node.text);
      if (index < 0) throw new Error('UNBOUND_IDENTIFIER');
      return values[index];
    }
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, values, depth + 1);
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken)
      return !evaluate(node.operand, values, depth + 1);
    if (ts.isBinaryExpression(node)) {
      const left = evaluate(node.left, values, depth + 1);
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return left && evaluate(node.right, values, depth + 1);
      if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        return left || evaluate(node.right, values, depth + 1);
      const right = evaluate(node.right, values, depth + 1);
      if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
      if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
    }
    if (ts.isConditionalExpression(node)) return evaluate(node.condition, values, depth + 1)
      ? evaluate(node.whenTrue, values, depth + 1) : evaluate(node.whenFalse, values, depth + 1);
    throw new Error('UNSUPPORTED_BOOLEAN_EXPRESSION');
  };
  try {
    const outputs: boolean[] = [];
    for (let bits = 0; bits < 2 ** names.length; bits++) {
      outputs.push(evaluate(expression, names.map((_, index) => Boolean(bits & (1 << index))), 0));
    }
    return { parameterCount: names.length, outputs, sourceHash,
      declarationLine: sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1 };
  } catch { return undefined; }
}

function analyze(obligation: VerificationObligation, repository: GenericRepository) {
  const before = obligation.change.identity.parentEntity;
  const after = obligation.change.identity.candidateEntity;
  if (obligation.question !== 'BEHAVIORAL_COMPATIBILITY' || obligation.scope !== 'PROVIDER' ||
      obligation.reference || obligation.change.identity.status !== 'CONFIRMED_IDENTITY' ||
      !before || !after || before.kind !== 'FUNCTION' || after.kind !== 'FUNCTION' ||
      before.name !== after.name ||
      before.projectId !== obligation.projectId) return undefined;
  const parent = readFiniteBooleanModel(repository.parentSnapshot, before.filePath, before.name);
  const candidate = readFiniteBooleanModel(repository.candidateSnapshot, after.filePath, after.name);
  if (!parent || !candidate || parent.parameterCount !== candidate.parameterCount) return undefined;
  const mismatch = parent.outputs.findIndex((value, index) => value !== candidate.outputs[index]);
  return { parent, candidate, mismatch, before, after };
}

/** Proposal is replayed by the independently registered checker before use. */
export class TypeScriptFiniteBooleanProof {
  public static propose(obligation: VerificationObligation, repository: GenericRepository): VerificationVerdict | undefined {
    const result = analyze(obligation, repository);
    if (!result) return undefined;
    const { parent, candidate, mismatch, before, after } = result;
    const verdictId = `verd_${obligation.obligationId}`;
    const evidenceId = `ev_${obligation.obligationId}`;
    const trace = parent.outputs.map((value, index) => ({ ruleApplied: 'FINITE_BOOLEAN_EXHAUSTION_V1',
      stepIndex: index, premises: [String(index), String(value), String(candidate.outputs[index])],
      conclusion: value === candidate.outputs[index] ? 'EQUAL' : 'DIFFERENT' }));
    return { verdictId, obligationId: obligation.obligationId, targetEntityId: before.entityId,
      outcome: mismatch < 0 ? 'PRESERVED' : 'VIOLATED', assurance: 'F0_FORMAL', property: 'BEHAVIOR',
      scope: 'PROVIDER', provenance: { repositoryId: repository.repositoryId, projectId: obligation.projectId,
        identityId: obligation.change.identity.identityId, obligationId: obligation.obligationId,
        evidenceId, verdictId }, timestamp: new Date().toISOString(),
      evidence: { evidenceId, assurance: 'F0_FORMAL', property: 'BEHAVIOR',
        f0Formal: { proofTrace: trace, ...(mismatch < 0 ? {} : { operationalWitness: {
          inputDomainWitness: Array.from({ length: parent.parameterCount }, (_, index) => Boolean(mismatch & (1 << index))),
          parentOutcome: String(parent.outputs[mismatch]), candidateOutcome: String(candidate.outputs[mismatch])
        } }) },
        metadata: { verificationProfile: TS_FINITE_BOOLEAN_BEHAVIOR_V1,
          parentSnapshot: repository.parentSnapshot.snapshotId, candidateSnapshot: repository.candidateSnapshot.snapshotId,
          parentFile: before.filePath, candidateFile: after.filePath,
          parentHash: parent.sourceHash, candidateHash: candidate.sourceHash,
          sourceFile: before.filePath, sourceLine: parent.declarationLine,
          parameterCount: parent.parameterCount, domainSize: parent.outputs.length,
          inputDomain: 'ALL_BOOLEAN_TUPLES_ONLY', semanticScope: 'PURE_TYPESCRIPT_BOOLEAN_EXPRESSION_V1',
          parserVersion: ts.version, parserDistributionDigest } } };
  }
}

/** Trusted checker re-derives every truth-table row from the sealed bytes. */
export class TypeScriptFiniteBooleanChecker implements EvidenceChecker {
  public readonly profileId = TS_FINITE_BOOLEAN_BEHAVIOR_V1;
  public check(obligation: VerificationObligation, repository: GenericRepository, verdict: VerificationVerdict): boolean {
    const expected = TypeScriptFiniteBooleanProof.propose(obligation, repository);
    if (!expected || verdict.assurance !== 'F0_FORMAL' || verdict.property !== 'BEHAVIOR') return false;
    return isDeepStrictEqual({ ...verdict, timestamp: '' }, { ...expected, timestamp: '' });
  }
}
