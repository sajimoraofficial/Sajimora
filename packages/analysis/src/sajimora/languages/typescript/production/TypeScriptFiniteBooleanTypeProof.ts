import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import ts from 'typescript';
import { EvidenceChecker, GenericRepository, GenericRepositorySnapshot,
  Reference, VerificationObligation, VerificationVerdict } from '../../../../../../core/src/sajimora/verification';
import { readFiniteBooleanModel } from './TypeScriptFiniteBooleanProof';

export const TS_FINITE_BOOLEAN_TYPE_V1 = 'TS_FINITE_BOOLEAN_TYPE_V1';

function readSource(snapshot: GenericRepositorySnapshot, file: string): string | undefined {
  const entries = snapshot.files.filter(entry => entry.path === file);
  if (entries.length !== 1 || entries[0].isSymlink || entries[0].byteLength > 256_000) return undefined;
  const source = snapshot.readTextFile(file);
  if (source === undefined) return undefined;
  const bytes = Buffer.from(source);
  const binary = snapshot.readBinaryFile(file);
  if (bytes.length !== entries[0].byteLength || createHash('sha256').update(bytes).digest('hex') !== entries[0].hash ||
      (binary !== undefined && !bytes.equals(Buffer.from(binary)))) return undefined;
  return source;
}

function consumerKind(reference: Reference, repository: GenericRepository, targetFile: string,
  targetName: string, arity: number): 'IMPORT' | 'CALL' | undefined {
  if (reference.isUnresolvedBoundary || !['STATIC_IMPORT', 'STATIC_CALL'].includes(reference.kind)) return undefined;
  const before = readSource(repository.parentSnapshot, reference.location.filePath);
  const after = readSource(repository.candidateSnapshot, reference.location.filePath);
  if (before === undefined || before !== after) return undefined;
  const sf = ts.createSourceFile(reference.location.filePath, before, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if ((sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return undefined;
  const imports: Array<{ node: ts.ImportSpecifier; local: string }> = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        !/^\.\.?\//.test(statement.moduleSpecifier.text) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings) || statement.importClause.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(reference.location.filePath),
      specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
    if (resolved !== targetFile) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === targetName && !element.isTypeOnly) {
        imports.push({ node: element, local: element.name.text });
      }
    }
  }
  if (imports.length !== 1) return undefined;
  let bindingUseSupported = true;
  const inspectBinding = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === imports[0].local && node !== imports[0].node.name &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node && !node.parent.questionDotToken)) {
      bindingUseSupported = false;
    }
    ts.forEachChild(node, inspectBinding);
  };
  inspectBinding(sf);
  if (!bindingUseSupported) return undefined;
  const matchLocation = (node: ts.Node): boolean => {
    const loc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return reference.location.line === loc.line + 1 && reference.location.character === loc.character + 1 &&
      reference.location.length === node.getWidth(sf);
  };
  if (reference.kind === 'STATIC_IMPORT') return matchLocation(imports[0].node) ? 'IMPORT' : undefined;
  let matched = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && matchLocation(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === imports[0].local && node.arguments.length === arity &&
        node.arguments.every(argument => argument.kind === ts.SyntaxKind.TrueKeyword ||
          argument.kind === ts.SyntaxKind.FalseKeyword) && !node.typeArguments?.length && !node.questionDotToken) matched = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return matched ? 'CALL' : undefined;
}

/** Explicit Boolean signatures make provider and admitted literal-call type
 * compatibility a finite syntactic proposition. Behavior is a separate rule. */
export class TypeScriptFiniteBooleanTypeProof {
  public static propose(obligation: VerificationObligation, repository: GenericRepository): VerificationVerdict | undefined {
    const before = obligation.change.identity.parentEntity;
    const after = obligation.change.identity.candidateEntity;
    if (obligation.change.identity.status !== 'CONFIRMED_IDENTITY' || !before || !after ||
        before.kind !== 'FUNCTION' || after.kind !== 'FUNCTION' || before.name !== after.name ||
        !['API_COMPATIBILITY', 'CONSUMER_COMPATIBILITY'].includes(obligation.question)) return undefined;
    const parent = readFiniteBooleanModel(repository.parentSnapshot, before.filePath, before.name);
    const candidate = readFiniteBooleanModel(repository.candidateSnapshot, after.filePath, after.name);
    if (!parent || !candidate || parent.parameterCount !== candidate.parameterCount) return undefined;
    const isApi = obligation.question === 'API_COMPATIBILITY' && obligation.scope === 'PROVIDER' &&
      obligation.projectId === before.projectId && !obligation.reference;
    const reference = obligation.reference;
    const kind = !isApi && obligation.scope === 'CONSUMER' && reference?.targetEntityId === before.entityId &&
      reference.projectId === obligation.projectId ? consumerKind(reference, repository, before.filePath,
        before.name, parent.parameterCount) : undefined;
    if (!isApi && !kind) return undefined;
    const verdictId = `verd_${obligation.obligationId}`;
    const evidenceId = `ev_${obligation.obligationId}`;
    const rule = isApi ? 'EXACT_BOOLEAN_SIGNATURE_V1' : kind === 'IMPORT'
      ? 'DIRECT_BOOLEAN_IMPORT_V1' : 'DIRECT_BOOLEAN_LITERAL_CALL_V1';
    const property = isApi ? 'API_TYPE' : 'CONSUMER_TYPE';
    return { verdictId, obligationId: obligation.obligationId, targetEntityId: reference?.targetEntityId ?? before.entityId,
      outcome: 'PRESERVED', assurance: 'F0_FORMAL', property, scope: obligation.scope,
      provenance: { repositoryId: repository.repositoryId, projectId: obligation.projectId,
        resolutionId: obligation.resolutionId, identityId: obligation.change.identity.identityId,
        referenceId: reference?.referenceId, obligationId: obligation.obligationId, evidenceId, verdictId },
      timestamp: new Date().toISOString(), evidence: { evidenceId, assurance: 'F0_FORMAL', property,
        f0Formal: { proofTrace: [{ ruleApplied: rule, stepIndex: 0,
          premises: [String(parent.parameterCount), parent.sourceHash, candidate.sourceHash],
          conclusion: 'TYPED_BOOLEAN_CONTRACT_PRESERVED' }] },
        metadata: { verificationProfile: TS_FINITE_BOOLEAN_TYPE_V1, inputDomain: 'ALL_BOOLEAN_TUPLES_ONLY',
          parentSnapshot: repository.parentSnapshot.snapshotId, candidateSnapshot: repository.candidateSnapshot.snapshotId,
          parentFile: before.filePath, candidateFile: after.filePath,
          consumerFile: reference?.location.filePath, referenceKind: reference?.kind,
          sourceFile: reference?.location.filePath ?? before.filePath,
          sourceLine: reference?.location.line ?? parent.declarationLine,
          parameterCount: parent.parameterCount } } };
  }
}

export class TypeScriptFiniteBooleanTypeChecker implements EvidenceChecker {
  public readonly profileId = TS_FINITE_BOOLEAN_TYPE_V1;
  public check(obligation: VerificationObligation, repository: GenericRepository, verdict: VerificationVerdict): boolean {
    const expected = TypeScriptFiniteBooleanTypeProof.propose(obligation, repository);
    return !!expected && isDeepStrictEqual({ ...verdict, timestamp: '' }, { ...expected, timestamp: '' });
  }
}
