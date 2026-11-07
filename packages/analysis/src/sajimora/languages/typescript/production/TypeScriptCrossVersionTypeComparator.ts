import * as crypto from 'node:crypto';
import * as ts from 'typescript';
import { GenericRepository, GenericRepositorySnapshot, SemanticEntity } from '../../../../../../core/src/sajimora/verification';
import { canonicalRepositoryPath, readSnapshotText } from './CanonicalRepositoryPath';
import { SealedCompilerHost } from './SealedCompilerHost';

export type CrossVersionTypeComparison =
  | { status: 'COMPATIBLE'; parentType: string; candidateType: string }
  | { status: 'INCOMPATIBLE'; parentType: string; candidateType: string; diagnostics: Array<{ code: number; message: string }> }
  | { status: 'UNKNOWN'; reason: string };

/** Builds a sealed compatibility program containing both revisions under
 * disjoint module roots. The assignment witness and both contracts are owned
 * by one Program/TypeChecker; ts.Type objects never cross checker boundaries. */
export class TypeScriptCrossVersionTypeComparator {
  public static compare(
    repository: GenericRepository,
    parentEntity: SemanticEntity,
    candidateEntity: SemanticEntity,
    compilerOptions: ts.CompilerOptions
  ): CrossVersionTypeComparison {
    if (parentEntity.kind !== candidateEntity.kind) return { status: 'UNKNOWN', reason: 'CROSS_VERSION_ENTITY_KIND_MISMATCH' };
    if (parentEntity.name !== candidateEntity.name) return { status: 'UNKNOWN', reason: 'CROSS_VERSION_EXPORT_NAME_MISMATCH' };
    if (parentEntity.name !== 'default' && !/^[$A-Z_a-z][$\w]*$/.test(parentEntity.name)) {
      return { status: 'UNKNOWN', reason: 'UNSUPPORTED_EXPORT_NAME' };
    }
    if (parentEntity.kind === 'ENUM') {
      return this.compareEnums(repository, parentEntity, candidateEntity);
    }

    const parentPrefix = '__sajimora_parent__';
    const candidatePrefix = '__sajimora_candidate__';
    const witnessPath = '__sajimora_compatibility_witness__.ts';
    const contents = new Map<string, string>();
    const copy = (snapshot: GenericRepositorySnapshot, prefix: string) => {
      for (const descriptor of snapshot.files) {
        const relative = canonicalRepositoryPath(descriptor.path, snapshot.rootIdentifier);
        if (relative === '__ESCAPE_ROOT__') return false;
        const text = readSnapshotText(snapshot, descriptor.path);
        if (text === undefined) return false;
        contents.set(`${prefix}/${relative}`, text);
      }
      return true;
    };
    if (!copy(repository.parentSnapshot, parentPrefix) || !copy(repository.candidateSnapshot, candidatePrefix)) {
      return { status: 'UNKNOWN', reason: 'SEALED_SNAPSHOT_READ_FAILURE' };
    }

    const modulePath = (prefix: string, filePath: string) => {
      const relative = canonicalRepositoryPath(filePath);
      if (relative === '__ESCAPE_ROOT__') return undefined;
      return `./${prefix}/${relative.replace(/(?:\.d)?\.[cm]?[jt]sx?$/i, '')}`;
    };
    const parentModule = modulePath(parentPrefix, parentEntity.filePath);
    const candidateModule = modulePath(candidatePrefix, candidateEntity.filePath);
    if (!parentModule || !candidateModule) return { status: 'UNKNOWN', reason: 'INVALID_DECLARATION_PATH' };

    const typeOnly = parentEntity.kind === 'INTERFACE' || parentEntity.kind === 'TYPE_ALIAS';
    const parentImport = parentEntity.name === 'default'
      ? `${typeOnly ? 'import type' : 'import'} ParentContract from ${JSON.stringify(parentModule)};`
      : `${typeOnly ? 'import type' : 'import'} { ${parentEntity.name} as ParentContract } from ${JSON.stringify(parentModule)};`;
    const candidateImport = candidateEntity.name === 'default'
      ? `${typeOnly ? 'import type' : 'import'} CandidateContract from ${JSON.stringify(candidateModule)};`
      : `${typeOnly ? 'import type' : 'import'} { ${candidateEntity.name} as CandidateContract } from ${JSON.stringify(candidateModule)};`;
    const witness = typeOnly
      ? `${parentImport}\n${candidateImport}\ndeclare const candidateValue: CandidateContract;\nconst historicalValue: ParentContract = candidateValue;\n`
      : `${parentImport}\n${candidateImport}\ndeclare const candidateValue: typeof CandidateContract;\nconst historicalValue: typeof ParentContract = candidateValue;\n`;
    contents.set(witnessPath, witness);

    const snapshot: GenericRepositorySnapshot = {
      snapshotId: `compat_${repository.parentSnapshot.snapshotId}_${repository.candidateSnapshot.snapshotId}`,
      rootIdentifier: '/',
      files: [...contents].map(([filePath, text]) => ({ path: filePath, byteLength: Buffer.byteLength(text, 'utf8'), hash: crypto.createHash('sha256').update(text).digest('hex') })),
      readTextFile: filePath => contents.get(canonicalRepositoryPath(filePath)),
      readBinaryFile: filePath => { const text = contents.get(canonicalRepositoryPath(filePath)); return text === undefined ? undefined : Buffer.from(text, 'utf8'); }
    };
    const options: ts.CompilerOptions = {
      ...compilerOptions,
      strict: compilerOptions.strict ?? true,
      noEmit: true,
      composite: false,
      incremental: false,
      declaration: false,
      declarationMap: false,
      emitDeclarationOnly: false,
      outDir: undefined,
      rootDir: undefined,
      baseUrl: undefined,
      paths: undefined,
      types: []
    };
    if (options.jsx === undefined && [...contents.keys()].some(file => /\.tsx$/i.test(file))) options.jsx = ts.JsxEmit.Preserve;
    const host = new SealedCompilerHost(snapshot, 'cross_version_compatibility', options);
    const program = ts.createProgram({ rootNames: [witnessPath], options, host });
    const source = program.getSourceFile(witnessPath);
    if (!source) return { status: 'UNKNOWN', reason: 'COMPATIBILITY_WITNESS_UNAVAILABLE' };
    const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    const normalized = diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      file: diagnostic.file ? canonicalRepositoryPath(diagnostic.file.fileName) : undefined
    }));
    if (normalized.some(diagnostic => diagnostic.file !== witnessPath)) {
      return { status: 'UNKNOWN', reason: 'COMPATIBILITY_ENVIRONMENT_INVALID' };
    }
    const assignmentCodes = new Set([2322, 2741]);
    if (normalized.some(diagnostic => !assignmentCodes.has(diagnostic.code))) {
      return { status: 'UNKNOWN', reason: 'COMPATIBILITY_ENVIRONMENT_INVALID' };
    }
    const checker = program.getTypeChecker();
    const parentImportNode = source.statements[0];
    const candidateImportNode = source.statements[1];
    const parentSymbol = ts.isImportDeclaration(parentImportNode) && parentImportNode.importClause
      ? checker.getSymbolAtLocation(parentImportNode.importClause.name ?? parentImportNode.importClause.namedBindings!) : undefined;
    const candidateSymbol = ts.isImportDeclaration(candidateImportNode) && candidateImportNode.importClause
      ? checker.getSymbolAtLocation(candidateImportNode.importClause.name ?? candidateImportNode.importClause.namedBindings!) : undefined;
    const parentDisplay = parentSymbol ? checker.typeToString(checker.getTypeOfSymbol(parentSymbol), undefined, ts.TypeFormatFlags.NoTruncation) : parentEntity.signatureFingerprint;
    const candidateDisplay = candidateSymbol ? checker.typeToString(checker.getTypeOfSymbol(candidateSymbol), undefined, ts.TypeFormatFlags.NoTruncation) : candidateEntity.signatureFingerprint;
    if (normalized.length) return { status: 'INCOMPATIBLE', parentType: parentDisplay, candidateType: candidateDisplay,
      diagnostics: normalized.map(({ code, message }) => ({ code, message })) };
    return { status: 'COMPATIBLE', parentType: parentDisplay, candidateType: candidateDisplay };
  }

  private static compareEnums(repository: GenericRepository, parentEntity: SemanticEntity,
    candidateEntity: SemanticEntity): CrossVersionTypeComparison {
    type Member = { name: string; initializer?: string; index: number };
    const extract = (snapshot: GenericRepositorySnapshot, entity: SemanticEntity): Member[] | undefined => {
      const text = readSnapshotText(snapshot, entity.filePath);
      if (text === undefined) return undefined;
      const source = ts.createSourceFile(canonicalRepositoryPath(entity.filePath), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      let declaration: ts.EnumDeclaration | undefined;
      source.forEachChild(node => {
        if (ts.isEnumDeclaration(node) && node.name.text === entity.name) declaration = node;
      });
      return declaration?.members.map((member, index) => ({
        name: ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
          ? member.name.text : member.name.getText(source),
        initializer: member.initializer?.getText(source).replace(/\s+/g, ' ').trim(), index
      }));
    };
    const parent = extract(repository.parentSnapshot, parentEntity);
    const candidate = extract(repository.candidateSnapshot, candidateEntity);
    if (!parent || !candidate) return { status: 'UNKNOWN', reason: 'ENUM_DECLARATION_UNAVAILABLE' };
    const candidateMap = new Map(candidate.map(member => [member.name, member]));
    for (const historical of parent) {
      const current = candidateMap.get(historical.name);
      if (!current) return { status: 'INCOMPATIBLE', parentType: parentEntity.signatureFingerprint,
        candidateType: candidateEntity.signatureFingerprint, diagnostics: [{ code: 2339, message: `Historical enum member ${historical.name} is missing.` }] };
      if (historical.initializer !== current.initializer) {
        return { status: 'UNKNOWN', reason: 'ENUM_VALUE_EQUIVALENCE_UNPROVEN' };
      }
      if (historical.initializer === undefined && historical.index !== current.index) {
        return { status: 'INCOMPATIBLE', parentType: parentEntity.signatureFingerprint,
          candidateType: candidateEntity.signatureFingerprint, diagnostics: [{ code: 2322, message: `Auto-valued enum member ${historical.name} changed ordinal.` }] };
      }
    }
    return { status: 'COMPATIBLE', parentType: parentEntity.signatureFingerprint, candidateType: candidateEntity.signatureFingerprint };
  }
}
