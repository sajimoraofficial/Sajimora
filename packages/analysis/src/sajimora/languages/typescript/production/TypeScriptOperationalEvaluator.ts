import * as ts from 'typescript';
import { GenericRepository, VerificationObligation, VerificationVerdict } from '../../../../../../core/src/sajimora/verification';
import { readSnapshotText } from './CanonicalRepositoryPath';

/** Source-bound numeric counterexamples only. Sampling never proves equivalence. */
export class TypeScriptOperationalEvaluator {
  public static evaluateOperationalBehavior(obligation: VerificationObligation, repository?: GenericRepository): VerificationVerdict {
    const parent = obligation.change.identity.parentEntity;
    const candidate = obligation.change.identity.candidateEntity;
    const verdictId = `verd_${obligation.obligationId}`;
    const evidenceId = `ev_${obligation.obligationId}`;
    const base = {
      verdictId, obligationId: obligation.obligationId,
      targetEntityId: obligation.reference?.targetEntityId ?? parent?.entityId ?? candidate?.entityId ?? 'unresolved',
      property: 'BEHAVIOR' as const, scope: obligation.scope,
      provenance: { repositoryId: repository?.repositoryId ?? 'unresolved', projectId: obligation.projectId,
        resolutionId: obligation.resolutionId, identityId: obligation.change.identity.identityId,
        referenceId: obligation.reference?.referenceId, obligationId: obligation.obligationId, evidenceId, verdictId },
      timestamp: new Date().toISOString()
    };
    const unknown = (reason: string): VerificationVerdict => ({ ...base, outcome: 'UNKNOWN', assurance: 'UNRESOLVED',
      evidence: { evidenceId, assurance: 'UNRESOLVED', property: 'BEHAVIOR', unresolvedBoundary: {
        taxonomyCode: reason, description: 'No independently verified operational preservation proof is available for this source-bound fragment.',
        remediation: { code: 'RETAIN_RUNTIME_TESTS', suggestion: 'Keep runtime tests enabled; syntax or sampling cannot certify unsupported behavior.' }
      } } });
    if (!repository?.parentSnapshot || !repository.candidateSnapshot || !parent || !candidate) return unknown('MISSING_OPERATIONAL_SOURCE');
    const extract = (source: string | undefined, name: string) => {
      if (source === undefined) return undefined;
      const sf = ts.createSourceFile('operational.ts', source, ts.ScriptTarget.Latest, true);
      if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return undefined;
      const declarations = sf.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
      if (declarations.length !== 1) return undefined;
      const fn = declarations[0];
      if (!fn.body || fn.body.statements.length !== 1 || fn.asteriskToken || fn.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
      if (fn.parameters.length !== 1 || fn.typeParameters?.length) return undefined;
      const param = fn.parameters[0];
      if (!ts.isIdentifier(param.name) || (param.type && param.type.kind !== ts.SyntaxKind.NumberKeyword) || param.initializer || param.questionToken || param.dotDotDotToken) return undefined;
      const statement = fn.body.statements[0];
      if (!ts.isReturnStatement(statement) || !statement.expression) return undefined;
      return { returnExpression: statement.expression, parameter: param.name.text };
    };
    const p = repository?.parentSnapshot && parent ? extract(readSnapshotText(repository.parentSnapshot, parent.filePath), parent.name) : undefined;
    const c = repository?.candidateSnapshot && candidate ? extract(readSnapshotText(repository.candidateSnapshot, candidate.filePath), candidate.name) : undefined;
    if (!p || !c) return unknown('OPERATIONAL_FRAGMENT_UNSUPPORTED');
    const run = (expression: ts.Expression, parameter: string, input: number): number => {
      let remaining = 256;
      const visit = (node: ts.Expression): number => {
        if (--remaining < 0) throw new Error('OPERATIONAL_BUDGET_EXCEEDED');
        if (ts.isNumericLiteral(node)) return Number(node.text);
        if (ts.isIdentifier(node) && node.text === parameter) return input;
        if (ts.isParenthesizedExpression(node)) return visit(node.expression);
        if (ts.isPrefixUnaryExpression(node)) {
          if (node.operator === ts.SyntaxKind.MinusToken) return -visit(node.operand);
          if (node.operator === ts.SyntaxKind.PlusToken) return +visit(node.operand);
          if (node.operator === ts.SyntaxKind.TildeToken) return ~visit(node.operand);
        }
        if (ts.isBinaryExpression(node)) {
          const left = visit(node.left), right = visit(node.right);
          switch (node.operatorToken.kind) {
            case ts.SyntaxKind.PlusToken: return left + right;
            case ts.SyntaxKind.MinusToken: return left - right;
            case ts.SyntaxKind.AsteriskToken: return left * right;
            case ts.SyntaxKind.SlashToken: return left / right;
            case ts.SyntaxKind.PercentToken: return left % right;
            case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
            case ts.SyntaxKind.AmpersandToken: return left & right;
            case ts.SyntaxKind.BarToken: return left | right;
            case ts.SyntaxKind.CaretToken: return left ^ right;
            case ts.SyntaxKind.LessThanLessThanToken: return left << right;
            case ts.SyntaxKind.GreaterThanGreaterThanToken: return left >> right;
            case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken: return left >>> right;
          }
        }
        throw new Error('OPERATIONAL_FRAGMENT_UNSUPPORTED');
      };
      return visit(expression);
    };
    const encode = (value: number): string => Object.is(value, -0) ? '-0' : String(value);
    try {
      for (const input of [0, 1, 2, -1, Number.MAX_SAFE_INTEGER + 1]) {
        const before = run(p.returnExpression, p.parameter, input);
        const after = run(c.returnExpression, c.parameter, input);
        if (!Object.is(before, after)) {
          if (!Object.is(before, run(p.returnExpression, p.parameter, input)) || !Object.is(after, run(c.returnExpression, c.parameter, input))) return unknown('WITNESS_REPLAY_FAILED');
          return { ...base, outcome: 'VIOLATED', assurance: 'WITNESS', evidence: {
            evidenceId, assurance: 'WITNESS', property: 'BEHAVIOR',
            f0Formal: { proofTrace: [], operationalWitness: { inputDomainWitness: [input], parentOutcome: encode(before), candidateOutcome: encode(after) } },
            metadata: { verificationProfile: 'TS_PURE_NUMERIC_WITNESS_V1', route: 'PURE_NUMERIC_COUNTEREXAMPLE_V1', parentFile: parent.filePath, candidateFile: candidate.filePath,
              parentSnapshot: repository.parentSnapshot.snapshotId, candidateSnapshot: repository.candidateSnapshot.snapshotId }
          } };
        }
      }
    } catch { return unknown('OPERATIONAL_FRAGMENT_UNSUPPORTED'); }
    return unknown('OPERATIONAL_PRESERVATION_UNPROVEN');
  }
}
