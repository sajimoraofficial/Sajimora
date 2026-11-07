import * as ts from 'typescript';
import { createHash } from 'node:crypto';
import { EvidenceChecker, GenericRepository, GenericRepositorySnapshot, VerificationObligation, VerificationVerdict } from '../../../../../../core/src/sajimora/verification';
import { readSnapshotText } from './CanonicalRepositoryPath';

/** Independent source replay of a single numeric counterexample. Does not call
 * the producer, execute repository code, or infer equivalence from sampling. */
export class TypeScriptNumericWitnessChecker implements EvidenceChecker {
  public readonly profileId = 'TS_PURE_NUMERIC_WITNESS_V1';

  public check(obligation: VerificationObligation, repository: GenericRepository, verdict: VerificationVerdict): boolean {
    if (obligation.question !== 'BEHAVIORAL_COMPATIBILITY' || obligation.scope !== 'PROVIDER' ||
        verdict.assurance !== 'WITNESS' || verdict.outcome !== 'VIOLATED' || verdict.property !== 'BEHAVIOR') return false;
    const parent = obligation.change.identity.parentEntity;
    const candidate = obligation.change.identity.candidateEntity;
    const witness = verdict.evidence.f0Formal?.operationalWitness;
    const meta = verdict.evidence.metadata;
    if (!parent || !candidate || parent.kind !== 'FUNCTION' || candidate.kind !== 'FUNCTION' ||
        !witness || witness.inputDomainWitness.length !== 1 || typeof witness.inputDomainWitness[0] !== 'number' ||
        !Number.isFinite(witness.inputDomainWitness[0]) ||
        meta?.['parentSnapshot'] !== repository.parentSnapshot.snapshotId || meta?.['candidateSnapshot'] !== repository.candidateSnapshot.snapshotId ||
        meta?.['parentFile'] !== parent.filePath || meta?.['candidateFile'] !== candidate.filePath) return false;
    const input = witness.inputDomainWitness[0];
    try {
      const before = this.replay(repository.parentSnapshot, parent.filePath, parent.name, input);
      const after = this.replay(repository.candidateSnapshot, candidate.filePath, candidate.name, input);
      const encode = (n: number) => Object.is(n, -0) ? '-0' : String(n);
      return !Object.is(before, after) && encode(before) === witness.parentOutcome && encode(after) === witness.candidateOutcome;
    } catch { return false; }
  }

  private replay(snapshot: GenericRepositorySnapshot, file: string, name: string, input: number): number {
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
    const matches = snapshot.files.filter(entry => normalize(entry.path) === normalize(file));
    const source = readSnapshotText(snapshot, file);
    if (matches.length !== 1 || source === undefined || source.length > 1_000_000 ||
        createHash('sha256').update(source).digest('hex') !== matches[0].hash ||
        Buffer.byteLength(source) !== matches[0].byteLength) throw new Error('UNSEALED_SOURCE');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    if ((tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw new Error('INVALID_SOURCE');
    // No executable module initialization or reassignment of the target binding.
    // Broader modules require separate effect and binding verification.
    if (!tree.statements.every(s => ts.isFunctionDeclaration(s) && !!s.body &&
        !s.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword))) throw new Error('UNSUPPORTED_MODULE_EFFECTS');
    const functions = tree.statements.filter((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (functions.length !== 1) throw new Error('AMBIGUOUS_DECLARATION');
    const fn = functions[0];
    if (!fn.body) throw new Error('UNSUPPORTED_BODY');
    if (fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name)) throw new Error('UNSUPPORTED_PARAM');
    const param = fn.parameters[0];
    const statements = fn.body.statements;
    if (statements.length === 0) throw new Error('UNSUPPORTED_BODY');
    const returnStatement = statements[statements.length - 1];
    if (!ts.isReturnStatement(returnStatement) || !returnStatement.expression) throw new Error('UNSUPPORTED_BODY');
    const bindings: Array<{ name: string; expr: ts.Expression }> = [];
    for (let i = 0; i < statements.length - 1; i++) {
      const stmt = statements[i];
      if (!ts.isVariableStatement(stmt)) throw new Error('UNSUPPORTED_BODY');
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) throw new Error('UNSUPPORTED_BINDING');
        bindings.push({ name: decl.name.text, expr: decl.initializer });
      }
    }
    let budget = 256;
    const env = new Map<string, number>();
    env.set(param.name.getText(tree), input);
    const evaluate = (node: ts.Expression): number => {
      if (--budget < 0) throw new Error('WITNESS_BUDGET');
      if (ts.isNumericLiteral(node)) return Number(node.text);
      if (ts.isIdentifier(node)) {
        if (env.has(node.text)) return env.get(node.text)!;
        throw new Error('UNKNOWN_IDENTIFIER');
      }
      if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
      if (ts.isPrefixUnaryExpression(node)) {
        if (node.operator === ts.SyntaxKind.MinusToken) return -evaluate(node.operand);
        if (node.operator === ts.SyntaxKind.PlusToken) return +evaluate(node.operand);
        if (node.operator === ts.SyntaxKind.TildeToken) return ~evaluate(node.operand);
      }
      if (ts.isBinaryExpression(node)) {
        const left = evaluate(node.left), right = evaluate(node.right);
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
      throw new Error('UNSUPPORTED_EXPRESSION');
    };
    for (const b of bindings) {
      env.set(b.name, evaluate(b.expr));
    }
    return evaluate(returnStatement.expression);
  }
}
