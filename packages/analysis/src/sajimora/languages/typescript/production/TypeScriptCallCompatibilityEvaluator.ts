import * as ts from 'typescript';
import { GenericRepository, VerificationObligation, VerificationVerdict } from '../../../../../../core/src/sajimora/verification';
import { TypeScriptCandidateContext } from './TypeScriptCandidateContext';
import { SealedCompilerHost } from './SealedCompilerHost';

export class TypeScriptCallCompatibilityEvaluator {
  public static evaluateCall(obligation: VerificationObligation, repository: GenericRepository): VerificationVerdict {
    return TypeScriptCandidateContext.evaluate(obligation, repository);
  }

  /** Convenience relation for closed type expressions, not a diagnostic receipt.
   * Production uses the complete historical consumer compilation above. */
  public static isTypeAssignable(source: string, target: string): boolean {
    if (source.length + target.length > 32768) return false;
    const file = 'relation.ts';
    const text = `type Source = ${source}; type Target = ${target};`;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (sf.statements.length !== 2 || !sf.statements.every(ts.isTypeAliasDeclaration)) return false;
    const snapshot = { snapshotId: 'closed-type-relation', rootIdentifier: '/',
      files: [{ path: file, byteLength: Buffer.byteLength(text), hash: '' }],
      readTextFile: (p: string) => p.replace(/^\//, '') === file ? text : undefined,
      readBinaryFile: () => undefined };
    const options: ts.CompilerOptions = { strict: true, types: [], target: ts.ScriptTarget.ES2022, noEmit: true };
    const program = ts.createProgram([file], options, new SealedCompilerHost(snapshot, 'relation', options));
    if (ts.getPreEmitDiagnostics(program).length) return false;
    const aliases = program.getSourceFile(file)!.statements as unknown as readonly ts.TypeAliasDeclaration[];
    const checker = program.getTypeChecker();
    const from = checker.getTypeFromTypeNode(aliases[0].type), to = checker.getTypeFromTypeNode(aliases[1].type);
    if ((from.flags | to.flags) & ts.TypeFlags.Any) return false;
    return checker.isTypeAssignableTo(from, to);
  }
}
