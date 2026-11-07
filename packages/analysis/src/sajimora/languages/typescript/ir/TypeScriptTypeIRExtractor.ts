import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  binaryCompare,
  canonicalJson,
  HASH_SCHEMA_VERSION,
  CanonicalHashDomain,
  Phase4BlockerId
} from '@sajimora/core';
import {
  TypeScriptTypeIR,
  PrimitiveTypeIR,
  LiteralTypeIR,
  UnionTypeIR,
  IntersectionTypeIR,
  ObjectTypeIR,
  ArrayTypeIR,
  TupleTypeIR,
  TupleElementIR,
  TupleElementCardinality,
  CallableTypeIR,
  TypeScriptTypeParameterIR,
  TypeReferenceIR,
  RecursionBackreferenceIR,
  UnsupportedTypeIR,
  TypeScriptPropertyDescriptorIR,
  TypeScriptSignatureIR,
  TypeScriptParameterIR,
  TypeScriptIndexSignatureIR,
  TypeScriptTypePredicateIR,
  TypeOrigin,
  TypeProvenanceKind
} from './TypeScriptTypeIR';

export interface ExtractionScopeFrame {
  readonly symbolId: string;
  readonly scopeBindingId: string;
  readonly instantiatedTypeArgumentHashes: ReadonlyArray<string>;
  readonly depth: number;
}

export interface ExtractorContext {
  readonly checker: ts.TypeChecker;
  readonly snapshot: 'PARENT' | 'CANDIDATE';
  readonly sourceFile?: ts.SourceFile;
  readonly scopeStack: ExtractionScopeFrame[];
  readonly maxDepth: number;
  readonly maxNodes: number;
  nodeCount: number;
  readonly snapshotRoot?: string;
  readonly program?: ts.Program;
  currentDecl?: ts.Node;
}

export class TypeScriptTypeIRExtractor {
  public static normalizeSourceFilePath(
    fileName: string,
    checkerOrProgramOrRoot?: ts.TypeChecker | ts.Program | string,
    explicitRoot?: string
  ): string {
    if (!fileName) return '';
    const slash = (s: string) => s.replace(/\\/g, '/');
    let normalized = slash(fileName);

    let root: string | undefined;
    if (explicitRoot) {
      root = slash(explicitRoot);
    } else if (typeof checkerOrProgramOrRoot === 'string') {
      root = slash(checkerOrProgramOrRoot);
    } else if (checkerOrProgramOrRoot && typeof (checkerOrProgramOrRoot as any).getCurrentDirectory === 'function') {
      root = slash((checkerOrProgramOrRoot as ts.Program).getCurrentDirectory());
    } else if (checkerOrProgramOrRoot && (checkerOrProgramOrRoot as any).snapshotRoot) {
      root = slash((checkerOrProgramOrRoot as any).snapshotRoot);
    } else if (checkerOrProgramOrRoot) {
      try {
        const prog = (checkerOrProgramOrRoot as any)?.getProgram?.();
        if (prog?.getCurrentDirectory) {
          root = slash(prog.getCurrentDirectory());
        }
      } catch {
        // ignore
      }
    }
    if (!root) {
      root = slash(process.cwd());
    }

    if (root && normalized.toLowerCase().startsWith(root.toLowerCase() + '/')) {
      return normalized.substring(root.length + 1);
    }
    const rel = slash(path.relative(root, fileName));
    if (!rel.startsWith('../') && !path.isAbsolute(rel)) {
      return rel;
    }

    const parsed = path.parse(fileName);
    if (parsed.root) {
      return slash(fileName.substring(parsed.root.length));
    }
    return normalized;
  }

  public static scorePathMatch(pathA?: string, pathB?: string): number {
    if (!pathA || !pathB) return 0;
    const isWindows = process.platform === 'win32';
    const rawA = pathA.replace(/\\/g, '/');
    const rawB = pathB.replace(/\\/g, '/');

    if (rawA === rawB) return 10000;
    if (isWindows && rawA.toLowerCase() === rawB.toLowerCase()) return 9999;

    if (rawA.endsWith('/' + rawB) || rawB.endsWith('/' + rawA)) return 5000 + Math.min(rawA.length, rawB.length);
    if (isWindows) {
      const aLower = rawA.toLowerCase();
      const bLower = rawB.toLowerCase();
      if (aLower.endsWith('/' + bLower) || bLower.endsWith('/' + aLower)) {
        return 5000 + Math.min(rawA.length, rawB.length);
      }
    }

    const partsA = (isWindows ? rawA.toLowerCase() : rawA).split('/').filter(Boolean);
    const partsB = (isWindows ? rawB.toLowerCase() : rawB).split('/').filter(Boolean);
    if (partsA.length === 0 || partsB.length === 0) return 0;
    if (partsA[partsA.length - 1] !== partsB[partsB.length - 1]) return 0;

    let matched = 0;
    while (
      matched < partsA.length &&
      matched < partsB.length &&
      partsA[partsA.length - 1 - matched] === partsB[partsB.length - 1 - matched]
    ) {
      matched++;
    }
    return matched;
  }

  public static determineProvenance(
    sf?: ts.SourceFile,
    program?: ts.Program,
    checker?: ts.TypeChecker
  ): TypeProvenanceKind {
    if (!sf) return 'SYNTHESIZED';
    const prog = program ?? (checker as any)?.getProgram?.();
    if (prog?.isSourceFileDefaultLibrary?.(sf)) {
      return 'DEFAULT_LIBRARY';
    }
    const fileName = sf.fileName.replace(/\\/g, '/');
    if (
      fileName.includes('/typescript/lib/') ||
      fileName.includes('/typescript/lib/lib.') ||
      /\/lib\.[^/]+\.d\.ts$/.test(fileName)
    ) {
      return 'DEFAULT_LIBRARY';
    }
    if (fileName.includes('/node_modules/')) {
      return 'EXTERNAL_LIBRARY';
    }
    if (sf.isDeclarationFile) {
      return 'USER_DECLARATION';
    }
    return 'USER_SOURCE';
  }

  public static computeIRContentHash(canonicalObj: Record<string, unknown>): string {
    const domain: CanonicalHashDomain = 'TYPE_IR';
    const json = canonicalJson(canonicalObj);
    const content = `${domain}\0${HASH_SCHEMA_VERSION}\0${json}`;
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }

  public static extractFromType(
    type: ts.Type,
    checker: ts.TypeChecker,
    snapshot: 'PARENT' | 'CANDIDATE',
    sourceFile?: ts.SourceFile,
    options?: { maxDepth?: number; maxNodes?: number; isFreshLiteral?: boolean; snapshotRoot?: string; program?: ts.Program; currentDecl?: ts.Node }
  ): TypeScriptTypeIR {
    const ctx: ExtractorContext = {
      checker,
      snapshot,
      sourceFile,
      scopeStack: [],
      maxDepth: options?.maxDepth ?? 50,
      maxNodes: options?.maxNodes ?? 5000,
      nodeCount: 0,
      snapshotRoot: options?.snapshotRoot,
      program: options?.program,
      currentDecl: options?.currentDecl
    };

    return this.extractTypeInternal(type, ctx, options?.isFreshLiteral);
  }

  public static extractFromNode(
    node: ts.Node,
    checker: ts.TypeChecker,
    snapshot: 'PARENT' | 'CANDIDATE',
    options?: { maxDepth?: number; maxNodes?: number; snapshotRoot?: string; program?: ts.Program }
  ): TypeScriptTypeIR {
    const isFreshLiteral = ts.isObjectLiteralExpression(node);
    let type: ts.Type;
    try {
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        const sym = (node as any).name ? checker.getSymbolAtLocation((node as any).name) : undefined;
        if (sym) {
          type = checker.getDeclaredTypeOfSymbol(sym);
        } else {
          type = checker.getTypeAtLocation(node);
        }
      } else if ((node as any).name) {
        const sym = checker.getSymbolAtLocation((node as any).name);
        if (sym) {
          type = checker.getTypeOfSymbolAtLocation(sym, node);
        } else {
          type = checker.getTypeAtLocation(node);
        }
      } else {
        type = checker.getTypeAtLocation(node);
      }
    } catch {
      return this.createUnsupportedIR('CHECKER_RUNTIME_FAILURE', snapshot, node.getText());
    }

    const sourceFile = node.getSourceFile();
    return this.extractFromType(type, checker, snapshot, sourceFile, {
      ...options,
      isFreshLiteral,
      currentDecl: node
    });
  }

  private static checkBudget(ctx: ExtractorContext, rawSyntax?: string): UnsupportedTypeIR | null {
    ctx.nodeCount++;
    if (ctx.nodeCount > ctx.maxNodes) {
      return this.createUnsupportedIR('TYPE_IR_BUDGET_EXCEEDED', ctx.snapshot, rawSyntax);
    }
    if (ctx.scopeStack.length > ctx.maxDepth) {
      return this.createUnsupportedIR('TYPE_IR_BUDGET_EXCEEDED', ctx.snapshot, rawSyntax);
    }
    return null;
  }

  public static createUnsupportedIR(
    blockerId: Phase4BlockerId,
    snapshot: 'PARENT' | 'CANDIDATE',
    rawSyntaxSnippet?: string
  ): UnsupportedTypeIR {
    const canonicalObj = {
      kind: 'UNSUPPORTED',
      blockerId,
      rawSyntaxSnippet: rawSyntaxSnippet ?? ''
    };
    const irContentHash = this.computeIRContentHash(canonicalObj);
    return {
      schemaVersion: 'SAJIMORA_TYPE_IR_V1',
      kind: 'UNSUPPORTED',
      blockerId,
      rawSyntaxSnippet,
      display: `unsupported(${blockerId})`,
      irContentHash,
      origin: { snapshot, file: '' }
    };
  }

  private static extractTypeInternal(
    type: ts.Type,
    ctx: ExtractorContext,
    isFreshLiteral?: boolean
  ): TypeScriptTypeIR {
    const budgetError = this.checkBudget(ctx);
    if (budgetError) return budgetError;

    const flags = type.getFlags();

    // 1. Primitive types
    if (flags & ts.TypeFlags.String) return this.createPrimitiveIR('string', ctx.snapshot);
    if (flags & ts.TypeFlags.Number) return this.createPrimitiveIR('number', ctx.snapshot);
    if (flags & ts.TypeFlags.Boolean) return this.createPrimitiveIR('boolean', ctx.snapshot);
    if (flags & ts.TypeFlags.ESSymbol) return this.createPrimitiveIR('symbol', ctx.snapshot);
    if (flags & ts.TypeFlags.BigInt) return this.createPrimitiveIR('bigint', ctx.snapshot);
    if (flags & ts.TypeFlags.Undefined) return this.createPrimitiveIR('undefined', ctx.snapshot);
    if (flags & ts.TypeFlags.Null) return this.createPrimitiveIR('null', ctx.snapshot);
    if (flags & ts.TypeFlags.Void) return this.createPrimitiveIR('void', ctx.snapshot);
    if (flags & ts.TypeFlags.Never) return this.createPrimitiveIR('never', ctx.snapshot);
    if (flags & ts.TypeFlags.Unknown) return this.createPrimitiveIR('unknown', ctx.snapshot);
    if (flags & ts.TypeFlags.Any) {
      const decl = ctx.currentDecl;
      const declSf = decl?.getSourceFile() ?? ctx.sourceFile;
      const provenance = TypeScriptTypeIRExtractor.determineProvenance(declSf, ctx.program, ctx.checker);
      const file = declSf ? TypeScriptTypeIRExtractor.normalizeSourceFilePath(declSf.fileName, ctx.snapshotRoot ?? ctx.checker) : '';
      let span: TypeOrigin['span'] | undefined;
      if (decl && declSf) {
        try {
          const start = decl.getStart();
          const end = decl.getEnd();
          const { line, character } = declSf.getLineAndCharacterOfPosition(start);
          span = { start, end, line: line + 1, column: character + 1 };
        } catch {
          // ignore
        }
      }
      return this.createPrimitiveIR('any', ctx.snapshot, {
        snapshot: ctx.snapshot,
        file,
        provenance,
        span
      });
    }

    // Helper to extract enumOrigin
    let enumOrigin: string | undefined;
    if (flags & (ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral)) {
      const sym = type.getSymbol() || type.aliasSymbol;
      if (sym) {
        const decl = sym.declarations?.[0];
        const enumDecl = decl ? (ts.isEnumMember(decl) ? decl.parent : (ts.isEnumDeclaration(decl) ? decl : undefined)) : undefined;
        if (enumDecl && ts.isEnumDeclaration(enumDecl)) {
          const normFile = TypeScriptTypeIRExtractor.normalizeSourceFilePath(enumDecl.getSourceFile().fileName, ctx.snapshotRoot ?? ctx.checker);
          const scopeParts: string[] = [];
          let curr: ts.Node | undefined = enumDecl.parent;
          while (curr && !ts.isSourceFile(curr)) {
            if ((curr as any).name?.text) scopeParts.unshift((curr as any).name.text);
            curr = curr.parent;
          }
          const qualifiedScope = scopeParts.length > 0 ? scopeParts.join('.') : 'root';
          enumOrigin = `decl:${normFile}#${qualifiedScope}#${enumDecl.name.text}`;
        }
      }
    }

    // 2. Literal types
    if (flags & ts.TypeFlags.StringLiteral) {
      const val = (type as ts.StringLiteralType).value;
      return this.createLiteralIR('string', JSON.stringify(val), ctx.snapshot, enumOrigin);
    }
    if (flags & ts.TypeFlags.NumberLiteral) {
      const val = (type as ts.NumberLiteralType).value;
      return this.createLiteralIR('number', String(val), ctx.snapshot, enumOrigin);
    }
    if (flags & ts.TypeFlags.BooleanLiteral) {
      // boolean literal intrinsic name is 'true' or 'false'
      const val = (type as any).intrinsicName === 'true' ? 'true' : 'false';
      return this.createLiteralIR('boolean', val, ctx.snapshot, enumOrigin);
    }
    if (flags & ts.TypeFlags.BigIntLiteral) {
      const val = (type as any).value;
      return this.createLiteralIR('bigint', `${val.negative ? '-' : ''}${val.base10Value}n`, ctx.snapshot, enumOrigin);
    }

    // 3. Union types
    if (type.isUnion()) {
      const members = type.types.map(t => this.extractTypeInternal(t, ctx));
      // Sort members by irContentHash in binary order
      members.sort((a, b) => binaryCompare(a.irContentHash, b.irContentHash));
      const memberHashes = members.map(m => m.irContentHash);
      const canonicalObj = {
        kind: 'UNION',
        members: memberHashes
      };
      const irContentHash = this.computeIRContentHash(canonicalObj);
      return {
        schemaVersion: 'SAJIMORA_TYPE_IR_V1',
        kind: 'UNION',
        members,
        display: members.map(m => m.display).join(' | '),
        irContentHash,
        origin: { snapshot: ctx.snapshot, file: ctx.sourceFile?.fileName ?? '' }
      };
    }

    // 4. Intersection types
    if (type.isIntersection()) {
      const isCallable = type.types.some(t => t.getCallSignatures().length > 0);
      const members = type.types.map(t => this.extractTypeInternal(t, ctx));
      // Pure non-callable intersections sorted by hash; callable/mixed preserves declaration order
      if (!isCallable) {
        members.sort((a, b) => binaryCompare(a.irContentHash, b.irContentHash));
      }
      const memberHashes = members.map(m => m.irContentHash);
      const canonicalObj = {
        isCallable,
        kind: 'INTERSECTION',
        members: memberHashes
      };
      const irContentHash = this.computeIRContentHash(canonicalObj);
      return {
        schemaVersion: 'SAJIMORA_TYPE_IR_V1',
        kind: 'INTERSECTION',
        isCallable,
        members,
        display: members.map(m => m.display).join(' & '),
        irContentHash,
        origin: { snapshot: ctx.snapshot, file: ctx.sourceFile?.fileName ?? '' }
      };
    }

    // 5. Type parameter
    if (flags & ts.TypeFlags.TypeParameter) {
      const tp = type as ts.TypeParameter;
      const name = tp.getSymbol()?.getName() ?? 'T';
      const binderScopeId = tp.getSymbol()?.valueDeclaration
        ? `decl:${tp.getSymbol()!.valueDeclaration!.getSourceFile().fileName}#${tp.getSymbol()!.getName()}`
        : `param:${name}`;
      const binderIndex = (tp as any).index ?? 0;

      let constraintIR: TypeScriptTypeIR | undefined;
      const constraint = tp.getConstraint();
      if (constraint) {
        constraintIR = this.extractTypeInternal(constraint, ctx);
      }
      let defaultIR: TypeScriptTypeIR | undefined;
      const def = tp.getDefault();
      if (def) {
        defaultIR = this.extractTypeInternal(def, ctx);
      }

      const canonicalObj = {
        binderIndex,
        binderScopeId,
        constraintHash: constraintIR ? constraintIR.irContentHash : null,
        defaultHash: defaultIR ? defaultIR.irContentHash : null,
        kind: 'TYPE_PARAMETER',
        name,
        variance: 'UNSPECIFIED'
      };
      const irContentHash = this.computeIRContentHash(canonicalObj);
      return {
        schemaVersion: 'SAJIMORA_TYPE_IR_V1',
        kind: 'TYPE_PARAMETER',
        name,
        binderScopeId,
        binderIndex,
        constraint: constraintIR,
        defaultType: defaultIR,
        display: name,
        irContentHash,
        origin: { snapshot: ctx.snapshot, file: ctx.sourceFile?.fileName ?? '' }
      };
    }

    // 6. Object-like: Arrays, Tuples, Reference, or general Object
    const isFresh = isFreshLiteral || Boolean(flags & (ts.TypeFlags as any).FreshLiteral);

    // Recursion / Cycle detection using symbol
    const symbol = type.getSymbol() || type.aliasSymbol;
    const decl0 = symbol?.declarations?.[0];
    const normFile = decl0
      ? TypeScriptTypeIRExtractor.normalizeSourceFilePath(decl0.getSourceFile().fileName, ctx.snapshotRoot ?? ctx.checker)
      : (ctx.sourceFile ? TypeScriptTypeIRExtractor.normalizeSourceFilePath(ctx.sourceFile.fileName, ctx.snapshotRoot ?? ctx.checker) : '');

    let scopeBindingId = '';
    if (symbol) {
      const symName = symbol.getName();
      const isAnonymous = symName === '__type' || symName === '__object' || symName === '' || symName.startsWith('__');
      if (decl0) {
        if (isAnonymous) {
          // Disambiguate anonymous declarations by start position to prevent false recursion backreferences
          scopeBindingId = `decl:${normFile}#${symName}@${decl0.getStart()}`;
        } else {
          scopeBindingId = `decl:${normFile}#${symName}`;
        }
      } else if (!isAnonymous) {
        scopeBindingId = `symbol:${symName}`;
      }
    }
    const symbolId = scopeBindingId;

    // Extract type arguments if reference
    const typeRef = type as ts.TypeReference;
    const typeArgs = typeRef.typeArguments ? Array.from(typeRef.typeArguments) : [];
    const typeArgHashes: string[] = [];
    const extractedTypeArgs: TypeScriptTypeIR[] = [];
    if (typeArgs.length > 0) {
      const refNodeArgs = (ctx.currentDecl as any)?.typeArguments as ts.NodeArray<ts.TypeNode> | undefined;
      for (let i = 0; i < typeArgs.length; i++) {
        const arg = typeArgs[i];
        const prevDecl = ctx.currentDecl;
        if (refNodeArgs && refNodeArgs[i]) {
          ctx.currentDecl = refNodeArgs[i];
        }
        const argIR = this.extractTypeInternal(arg, ctx);
        ctx.currentDecl = prevDecl;
        typeArgHashes.push(argIR.irContentHash);
        extractedTypeArgs.push(argIR);
      }
    }

    // Cycle check: look in ctx.scopeStack matching BOTH scopeBindingId and instantiatedTypeArgumentHashes
    if (symbolId) {
      const matchIdx = ctx.scopeStack.findIndex(frame => 
        frame.scopeBindingId === scopeBindingId &&
        frame.instantiatedTypeArgumentHashes.length === typeArgHashes.length &&
        frame.instantiatedTypeArgumentHashes.every((h, i) => h === typeArgHashes[i])
      );
      if (matchIdx !== -1) {
        const frame = ctx.scopeStack[matchIdx];
        const ancestorDepth = ctx.scopeStack.length - matchIdx;
        const canonicalObj = {
          ancestorDepth,
          instantiatedTypeArgumentHashes: frame.instantiatedTypeArgumentHashes,
          kind: 'RECURSION_BACKREFERENCE',
          scopeBindingId: frame.scopeBindingId
        };
        const irContentHash = this.computeIRContentHash(canonicalObj);
        return {
          schemaVersion: 'SAJIMORA_TYPE_IR_V1',
          kind: 'RECURSION_BACKREFERENCE',
          scopeBindingId: frame.scopeBindingId,
          ancestorDepth,
          instantiatedTypeArgumentHashes: frame.instantiatedTypeArgumentHashes,
          display: `recursive(${frame.scopeBindingId}, depth=${ancestorDepth})`,
          irContentHash,
          origin: { snapshot: ctx.snapshot, file: ctx.sourceFile?.fileName ?? '' }
        };
      }
    }

    // Push frame to scope stack
    if (symbolId) {
      ctx.scopeStack.push({
        symbolId,
        scopeBindingId,
        instantiatedTypeArgumentHashes: typeArgHashes,
        depth: ctx.scopeStack.length
      });
    }

    try {
      // 6a. Tuple Check
      if (ctx.checker.isTupleType(type)) {
        const tupleElements: TupleElementIR[] = [];
        let minLength = 0;
        let hasRest = false;

        const target = (type as any).target;
        const elementFlags = target?.elementFlags ?? [];
        const typeArguments = ctx.checker.getTypeArguments(type as ts.TypeReference) || [];
        const isReadonly = Boolean(
          (type as any).target?.readonly ||
          (type as any).readonly ||
          (ctx.checker.typeToString(type).startsWith('readonly '))
        );

        for (let i = 0; i < typeArguments.length; i++) {
          const elType = this.extractTypeInternal(typeArguments[i], ctx);
          const flag = elementFlags[i] ?? 0;
          let cardinality: TupleElementCardinality = 'REQUIRED';
          if (flag & ts.ElementFlags.Rest) {
            cardinality = 'REST';
            hasRest = true;
          } else if (flag & ts.ElementFlags.Optional) {
            cardinality = 'OPTIONAL';
          } else {
            cardinality = 'REQUIRED';
            minLength++;
          }
          tupleElements.push({
            type: elType,
            cardinality
          });
        }

        const canonicalObj = {
          elements: tupleElements.map(e => ({
            cardinality: e.cardinality,
            elementHash: e.type.irContentHash,
            label: null
          })),
          hasRest,
          isReadonly,
          kind: 'TUPLE',
          minLength
        };
        const irContentHash = this.computeIRContentHash(canonicalObj);
        return {
          schemaVersion: 'SAJIMORA_TYPE_IR_V1',
          kind: 'TUPLE',
          elements: tupleElements,
          minLength,
          hasRest,
          isReadonly,
          display: `${isReadonly ? 'readonly ' : ''}[${tupleElements.map(e => e.type.display).join(', ')}]`,
          irContentHash,
          origin: { snapshot: ctx.snapshot, file: ctx.sourceFile?.fileName ?? '' }
        };
      }

      // 6b. Array Check
      if (ctx.checker.isArrayType(type)) {
        const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference) || [];
        const elemType = typeArgs[0]
          ? this.extractTypeInternal(typeArgs[0], ctx)
          : this.createPrimitiveIR('unknown', ctx.snapshot);

        const canonicalObj = {
          elementTypeHash: elemType.irContentHash,
          isReadonly: false,
          kind: 'ARRAY'
        };
        const irContentHash = this.computeIRContentHash(canonicalObj);
        const elemProv = elemType.origin?.provenance;
        const provenance = (elemProv === 'DEFAULT_LIBRARY' || elemProv === 'EXTERNAL_LIBRARY')
          ? elemProv
          : this.determineProvenance(ctx.sourceFile, ctx.program, ctx.checker);
        return {
          schemaVersion: 'SAJIMORA_TYPE_IR_V1',
          kind: 'ARRAY',
          elementType: elemType,
          display: `${elemType.display}[]`,
          irContentHash,
          origin: {
            snapshot: ctx.snapshot,
            file: (elemProv === 'DEFAULT_LIBRARY' || elemProv === 'EXTERNAL_LIBRARY') && elemType.origin?.file
              ? elemType.origin.file
              : (ctx.sourceFile?.fileName ?? ''),
            provenance
          }
        };
      }

      // 6c. Pure Callable (functions without extra properties)
      const callSignatures = type.getCallSignatures();
      const constructSignatures = type.getConstructSignatures();
      const properties = type.getProperties();

      if (callSignatures.length > 0 && properties.length === 0 && constructSignatures.length === 0) {
        const sigIRs: TypeScriptSignatureIR[] = callSignatures.map((sig, idx) =>
          this.extractSignatureIR(sig, idx, ctx)
        );

        const canonicalObj = {
          kind: 'CALLABLE',
          signatures: sigIRs.map(s => this.canonicalSig(s))
        };
        const irContentHash = this.computeIRContentHash(canonicalObj);
        return {
          schemaVersion: 'SAJIMORA_TYPE_IR_V1',
          kind: 'CALLABLE',
          signatures: sigIRs,
          display: `(${sigIRs[0]?.parameters.map(p => `${p.name}: ${p.type.display}`).join(', ') ?? ''}) => ${sigIRs[0]?.returnType.display ?? 'void'}`,
          irContentHash,
          origin: { snapshot: ctx.snapshot, file: ctx.sourceFile?.fileName ?? '' }
        };
      }

      // 6d. General Object Type (properties, call signatures, index signatures)
      const propEntries: [string, TypeScriptPropertyDescriptorIR][] = [];
      const nominalOrigins: string[] = [];

      for (const prop of properties) {
        let propName = prop.getName();
        const decl = prop.valueDeclaration ?? prop.declarations?.[0];

        // Finding 12: Canonical unique symbol keys without compiler allocation counters
        if (propName.startsWith('__@')) {
          let symbolDecl: ts.Declaration | undefined;
          if (decl && (decl as any).name && ts.isComputedPropertyName((decl as any).name)) {
            const expr = (decl as any).name.expression;
            const sym = ctx.checker.getSymbolAtLocation(expr);
            symbolDecl = sym?.valueDeclaration ?? sym?.declarations?.[0];
          }
          if (!symbolDecl && prop.declarations) {
            for (const d of prop.declarations) {
              if ((d as any).name && ts.isComputedPropertyName((d as any).name)) {
                const expr = (d as any).name.expression;
                const sym = ctx.checker.getSymbolAtLocation(expr);
                symbolDecl = sym?.valueDeclaration ?? sym?.declarations?.[0];
                if (symbolDecl) break;
              }
            }
          }
          if (symbolDecl) {
            const symSf = symbolDecl.getSourceFile();
            const symNormFile = TypeScriptTypeIRExtractor.normalizeSourceFilePath(symSf.fileName, ctx.snapshotRoot ?? ctx.checker);
            const scopeParts: string[] = [];
            let curr: ts.Node | undefined = symbolDecl.parent;
            while (curr && !ts.isSourceFile(curr)) {
              if ((curr as any).name?.text) scopeParts.unshift((curr as any).name.text);
              curr = curr.parent;
            }
            const qualifiedScope = scopeParts.length > 0 ? scopeParts.join('.') : 'root';
            const symName = (symbolDecl as any).name?.text ?? propName.replace(/^__@/, '').replace(/@\d+$/, '');
            propName = `[symbol:decl:${symNormFile}#${qualifiedScope}#${symName}@${symbolDecl.getStart()}]`;
          } else {
            const baseName = propName.replace(/^__@/, '').replace(/@\d+$/, '');
            propName = `[symbol:${baseName}]`;
          }
        }
        let propType: ts.Type;
        try {
          propType = decl
            ? ctx.checker.getTypeOfSymbolAtLocation(prop, decl)
            : ctx.checker.getTypeOfSymbolAtLocation(prop, ctx.sourceFile ?? (ts as any).createNode(ts.SyntaxKind.Unknown));
        } catch {
          propType = ctx.checker.getAnyType();
        }

        const prevDecl = ctx.currentDecl;
        if (decl) ctx.currentDecl = decl;
        const propTypeIR = this.extractTypeInternal(propType, ctx);
        ctx.currentDecl = prevDecl;
        const isReadonly = Boolean(
          decl &&
            ts.getCombinedModifierFlags(decl as ts.Declaration) & ts.ModifierFlags.Readonly
        );
        const isOptional = Boolean(prop.flags & ts.SymbolFlags.Optional);

        let visibility: 'public' | 'protected' | 'private' = 'public';
        if (decl) {
          const modFlags = ts.getCombinedModifierFlags(decl as ts.Declaration);
          if (modFlags & ts.ModifierFlags.Private) visibility = 'private';
          else if (modFlags & ts.ModifierFlags.Protected) visibility = 'protected';
        }

        let originSymbolId: string | undefined;
        if (visibility !== 'public' && decl) {
          const scopeParts: string[] = [];
          let curr: ts.Node | undefined = decl.parent;
          while (curr && !ts.isSourceFile(curr)) {
            if (
              ts.isClassDeclaration(curr) ||
              ts.isInterfaceDeclaration(curr) ||
              ts.isModuleDeclaration(curr) ||
              ts.isFunctionDeclaration(curr) ||
              ts.isEnumDeclaration(curr) ||
              ts.isTypeAliasDeclaration(curr)
            ) {
              const name = (curr as any).name?.text ?? ts.SyntaxKind[curr.kind];
              scopeParts.unshift(name);
            }
            curr = curr.parent;
          }
          const qualifiedScope = scopeParts.length > 0 ? scopeParts.join('.') : 'anonymous';
          const normFile = TypeScriptTypeIRExtractor.normalizeSourceFilePath(
            decl.getSourceFile().fileName,
            ctx.snapshotRoot ?? ctx.checker
          );
          const classOrigin = `decl:${normFile}#${qualifiedScope}`;
          originSymbolId = `${classOrigin}.${propName}`;
          if (!nominalOrigins.includes(classOrigin)) {
            nominalOrigins.push(classOrigin);
          }
        }

        propEntries.push([
          propName,
          {
            type: propTypeIR,
            isReadonly,
            isOptional,
            visibility,
            originSymbolId
          }
        ]);
      }

      // Locale-independent binary sort by property name:
      propEntries.sort(([a], [b]) => binaryCompare(a, b));

      const callSigs: TypeScriptSignatureIR[] = callSignatures.map((sig, idx) =>
        this.extractSignatureIR(sig, idx, ctx)
      );

      const constructSigs: TypeScriptSignatureIR[] = constructSignatures.map((sig, idx) =>
        this.extractSignatureIR(sig, idx, ctx)
      );

      const indexSigs: TypeScriptIndexSignatureIR[] = [];
      const stringInfo = (ctx.checker as any).getIndexInfoOfType?.(type, ts.IndexKind.String) ?? (type as any).stringInfo;
      const stringIndex = type.getStringIndexType();
      if (stringIndex) {
        const isReadonly = Boolean(stringInfo?.isReadonly);
        indexSigs.push({
          keyType: 'string',
          valueType: this.extractTypeInternal(stringIndex, ctx),
          isReadonly
        });
      }
      const numberInfo = (ctx.checker as any).getIndexInfoOfType?.(type, ts.IndexKind.Number) ?? (type as any).numberInfo;
      const numberIndex = type.getNumberIndexType();
      if (numberIndex) {
        const isReadonly = Boolean(numberInfo?.isReadonly);
        indexSigs.push({
          keyType: 'number',
          valueType: this.extractTypeInternal(numberIndex, ctx),
          isReadonly
        });
      }

      const canonicalObj = {
        callSignatures: callSigs.map(s => this.canonicalSig(s)),
        constructSignatures: constructSigs.map(s => this.canonicalSig(s)),
        indexSignatures: indexSigs.map(i => ({
          isReadonly: Boolean(i.isReadonly),
          keyType: i.keyType,
          valueHash: i.valueType.irContentHash
        })),
        isFreshLiteral: isFresh,
        kind: 'OBJECT',
        nominalOrigins: nominalOrigins.sort(binaryCompare),
        properties: propEntries.map(([name, desc]) => [
          name,
          {
            hasGetter: desc.hasGetter ?? false,
            hasSetter: desc.hasSetter ?? false,
            isOptional: desc.isOptional ?? false,
            isReadonly: desc.isReadonly ?? false,
            originSymbolId: desc.originSymbolId ?? null,
            typeHash: desc.type.irContentHash,
            visibility: desc.visibility ?? 'public'
          }
        ]),
        typeArguments: extractedTypeArgs.map(t => t.irContentHash)
      };
      const irContentHash = this.computeIRContentHash(canonicalObj);
      return {
        schemaVersion: 'SAJIMORA_TYPE_IR_V1',
        kind: 'OBJECT',
        isFreshLiteral: isFresh,
        properties: propEntries,
        callSignatures: callSigs,
        constructSignatures: constructSigs,
        indexSignatures: indexSigs,
        nominalOrigins,
        typeArguments: extractedTypeArgs.length > 0 ? extractedTypeArgs : undefined,
        display: `{ ${propEntries.map(([name, desc]) => `${name}${desc.isOptional ? '?' : ''}: ${desc.type.display}`).join('; ')} }`,
        irContentHash,
        origin: { snapshot: ctx.snapshot, file: ctx.sourceFile?.fileName ?? '' }
      };
    } finally {
      if (symbolId) {
        ctx.scopeStack.pop();
      }
    }
  }

  public static createPrimitiveIR(
    primitiveKind: PrimitiveTypeIR['primitiveKind'],
    snapshot: 'PARENT' | 'CANDIDATE',
    origin?: TypeOrigin
  ): PrimitiveTypeIR {
    const canonicalObj = {
      kind: 'PRIMITIVE',
      primitiveKind
    };
    const irContentHash = this.computeIRContentHash(canonicalObj);
    return {
      schemaVersion: 'SAJIMORA_TYPE_IR_V1',
      kind: 'PRIMITIVE',
      primitiveKind,
      display: primitiveKind,
      irContentHash,
      origin: origin ?? { snapshot, file: '' }
    };
  }

  public static createLiteralIR(
    literalKind: LiteralTypeIR['literalKind'],
    value: string,
    snapshot: 'PARENT' | 'CANDIDATE',
    enumOrigin?: string
  ): LiteralTypeIR {
    const canonicalObj = {
      enumOrigin: enumOrigin ?? null,
      kind: 'LITERAL',
      literalKind,
      value
    };
    const irContentHash = this.computeIRContentHash(canonicalObj);
    return {
      schemaVersion: 'SAJIMORA_TYPE_IR_V1',
      kind: 'LITERAL',
      literalKind,
      value,
      enumOrigin,
      display: enumOrigin ? `${enumOrigin.split('#').pop()}.${value}` : value,
      irContentHash,
      origin: { snapshot, file: '' }
    };
  }

  private static canonicalSig(s: TypeScriptSignatureIR) {
    return {
      ordinal: s.declarationOrdinal,
      params: s.parameters.map(p => ({
        isRequired: p.isRequired,
        isRest: p.isRest,
        name: p.name,
        typeHash: p.type.irContentHash
      })),
      thisParam: s.thisParameter ? {
        name: s.thisParameter.name,
        typeHash: s.thisParameter.type.irContentHash
      } : null,
      predicate: s.typePredicate ? {
        kind: s.typePredicate.kind,
        paramName: s.typePredicate.parameterName ?? null,
        paramIdx: s.typePredicate.parameterIndex ?? null,
        targetHash: s.typePredicate.targetType?.irContentHash ?? ''
      } : null,
      typeParams: s.typeParameters?.map(tp => ({
        name: tp.name,
        constraintHash: tp.constraint?.irContentHash ?? ''
      })) ?? [],
      returnHash: s.returnType.irContentHash
    };
  }

  private static extractSignatureIR(
    sig: ts.Signature,
    idx: number,
    ctx: ExtractorContext
  ): TypeScriptSignatureIR {
    const params: TypeScriptParameterIR[] = sig.parameters.map(param => {
      const paramDecl = param.valueDeclaration as ts.ParameterDeclaration | undefined;
      const prevDecl = ctx.currentDecl;
      if (paramDecl) ctx.currentDecl = paramDecl;
      const paramType = ctx.checker.getTypeOfSymbolAtLocation(
        param,
        paramDecl ?? ctx.sourceFile ?? (ts as any).createNode(ts.SyntaxKind.Unknown)
      );
      const paramTypeIR = this.extractTypeInternal(paramType, ctx);
      ctx.currentDecl = prevDecl;
      const hasInitializer = Boolean(paramDecl && paramDecl.initializer);
      const hasQuestionToken = Boolean(paramDecl && paramDecl.questionToken);
      const isRest = Boolean(paramDecl && paramDecl.dotDotDotToken);
      const isOptional = Boolean(((param as any).flags & ts.SymbolFlags.Optional) || hasQuestionToken || hasInitializer);
      const isRequired = !isOptional && !isRest;
      return {
        name: param.getName(),
        type: paramTypeIR,
        isRequired,
        isRest,
        isOptional
      };
    });

    const retDecl = (sig.declaration as any)?.type ?? sig.declaration;
    const prevDecl = ctx.currentDecl;
    if (retDecl) ctx.currentDecl = retDecl;
    const retType = this.extractTypeInternal(sig.getReturnType(), ctx);
    ctx.currentDecl = prevDecl;
    const typeParams = this.extractSignatureTypeParameters(sig, ctx);

    // Finding 4: Explicit this parameter
    let thisParamIR: TypeScriptParameterIR | undefined;
    const thisSymbol = (sig as any).thisParameter;
    if (thisSymbol) {
      const thisDecl = thisSymbol.valueDeclaration ?? thisSymbol.declarations?.[0];
      const thisType = ctx.checker.getTypeOfSymbolAtLocation(
        thisSymbol,
        thisDecl ?? ctx.sourceFile ?? (ts as any).createNode(ts.SyntaxKind.Unknown)
      );
      if (thisType && !(thisType.flags & ts.TypeFlags.Void)) {
        thisParamIR = {
          name: 'this',
          type: this.extractTypeInternal(thisType, ctx),
          isRequired: true,
          isRest: false,
          isOptional: false
        };
      }
    } else {
      const decl = sig.getDeclaration();
      if (decl && (decl as any).parameters) {
        const thisParamDecl = (decl as any).parameters.find((p: any) => ts.isIdentifier(p.name) && p.name.text === 'this');
        if (thisParamDecl) {
          const thisType = ctx.checker.getTypeAtLocation(thisParamDecl);
          if (thisType && !(thisType.flags & ts.TypeFlags.Void)) {
            thisParamIR = {
              name: 'this',
              type: this.extractTypeInternal(thisType, ctx),
              isRequired: true,
              isRest: false,
              isOptional: false
            };
          }
        }
      }
    }

    // Finding 5: Type predicate and assertion effects
    let typePredicateIR: TypeScriptTypePredicateIR | undefined;
    const pred = ctx.checker.getTypePredicateOfSignature(sig);
    if (pred) {
      let kind: TypeScriptTypePredicateIR['kind'] = 'IDENTIFIER';
      const pKind = pred.kind as number;
      if (pKind === 2) {
        kind = 'ASSERTS_IDENTIFIER';
      } else if (pKind === 3) {
        kind = 'THIS';
      } else if (pKind === 4) {
        kind = 'ASSERTS_THIS';
      }
      const targetType = pred.type ? this.extractTypeInternal(pred.type, ctx) : undefined;
      typePredicateIR = {
        kind,
        parameterName: pred.parameterName,
        parameterIndex: pred.parameterIndex,
        targetType
      };
    }

    return {
      parameters: params,
      returnType: retType,
      thisParameter: thisParamIR,
      typePredicate: typePredicateIR,
      typeParameters: typeParams,
      declarationOrdinal: idx
    };
  }

  private static extractSignatureTypeParameters(
    sig: ts.Signature,
    ctx: ExtractorContext
  ): TypeScriptTypeParameterIR[] | undefined {
    const typeParams = sig.getTypeParameters ? sig.getTypeParameters() : (sig as any).typeParameters;
    const declTypeParams = (sig.declaration as any)?.typeParameters as ts.NodeArray<ts.TypeParameterDeclaration> | undefined;

    if ((!typeParams || typeParams.length === 0) && (!declTypeParams || declTypeParams.length === 0)) {
      return undefined;
    }

    const count = Math.max(typeParams?.length ?? 0, declTypeParams?.length ?? 0);
    const result: TypeScriptTypeParameterIR[] = [];

    for (let idx = 0; idx < count; idx++) {
      const tp = typeParams?.[idx];
      const declTp = declTypeParams?.[idx];

      const tpName = tp?.getSymbol()?.getName() ?? declTp?.name?.text ?? `T${idx}`;

      let constraintType: ts.Type | undefined;
      if (tp) {
        constraintType = tp.getConstraint ? tp.getConstraint() : (tp as any).constraint;
        if (!constraintType && ctx.checker.getBaseConstraintOfType) {
          constraintType = ctx.checker.getBaseConstraintOfType(tp);
        }
      }
      if (!constraintType && declTp?.constraint) {
        try {
          constraintType = ctx.checker.getTypeFromTypeNode(declTp.constraint);
        } catch {
          // ignore
        }
      }

      const constraintIR = constraintType ? this.extractTypeInternal(constraintType, ctx) : undefined;

      let defaultType: ts.Type | undefined;
      if (tp) {
        defaultType = tp.getDefault ? tp.getDefault() : (tp as any).default;
      }
      if (!defaultType && declTp?.default) {
        try {
          defaultType = ctx.checker.getTypeFromTypeNode(declTp.default);
        } catch {
          // ignore
        }
      }
      const defaultIR = defaultType ? this.extractTypeInternal(defaultType, ctx) : undefined;

      result.push({
        schemaVersion: 'SAJIMORA_TYPE_IR_V1',
        kind: 'TYPE_PARAMETER',
        name: tpName,
        binderScopeId: '',
        binderIndex: idx,
        constraint: constraintIR,
        defaultType: defaultIR,
        display: tpName + (constraintIR ? ` extends ${constraintIR.display}` : ''),
        irContentHash: this.computeIRContentHash({
          kind: 'TYPE_PARAMETER',
          name: tpName,
          constraintHash: constraintIR?.irContentHash ?? ''
        })
      });
    }

    return result.length > 0 ? result : undefined;
  }
}
