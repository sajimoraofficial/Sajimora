/**
 * @file JavaTypeIRExtractor.ts
 * Extracts JavaTypeIR and structural declarations from Java source text and AST nodes.
 * Connects J-1 and J-2 data into the language-neutral analysis model.
 * Deterministic, sealed, fail-closed. No JVM or JavaParser dependencies.
 */

import * as crypto from 'node:crypto';
import {
  canonicalJson,
  JAVA_TYPE_IR_SCHEMA_VERSION,
  JAVA_PRIMITIVE_KINDS,
  type JavaTypeIR,
  type JavaPrimitiveTypeIR,
  type JavaVoidTypeIR,
  type JavaReferenceTypeIR,
  type JavaWildcardTypeIR,
  type JavaArrayTypeIR,
  type JavaTypeParameterIR,
  type UnsupportedJavaTypeIR,
  type JavaPrimitiveKind
} from '@sajimora/core';
import {
  JavaClassDeclIR,
  JavaMethodSignatureIR,
  JavaFieldIR,
  JavaParameterIR,
  JavaImportIR,
  JavaCallSiteIR,
  JavaASTNode,
  computeJavaMethodHash,
  computeJavaFieldHash
} from './JavaTypeIR';

function hashTypeContent(content: object): string {
  return crypto
    .createHash('sha256')
    .update('SAJIMORA_JAVA_TYPE_IR_V1\0' + canonicalJson(content), 'utf8')
    .digest('hex');
}

export function mkPrimitive(kind: JavaPrimitiveKind, display: string): JavaPrimitiveTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashTypeContent({ kind: 'JAVA_PRIMITIVE', primitiveKind: kind }),
    display,
    kind: 'JAVA_PRIMITIVE',
    primitiveKind: kind
  };
}

export function mkVoid(display: string): JavaVoidTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashTypeContent({ kind: 'JAVA_VOID' }),
    display,
    kind: 'JAVA_VOID'
  };
}

export function mkReference(
  qualifiedName: string,
  typeArguments: ReadonlyArray<JavaTypeIR>,
  display: string
): JavaReferenceTypeIR {
  const segments = qualifiedName.split('.');
  const simpleName = segments[segments.length - 1];
  const isFullyQualified = segments.length > 1;
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashTypeContent({
      kind: 'JAVA_REFERENCE',
      qualifiedName,
      typeArguments: typeArguments.map(a => a.irContentHash)
    }),
    display,
    kind: 'JAVA_REFERENCE',
    qualifiedName,
    simpleName,
    isFullyQualified,
    typeArguments
  };
}

export function mkWildcard(
  bound: 'UNBOUNDED' | 'UPPER' | 'LOWER',
  boundType: JavaTypeIR | undefined,
  display: string
): JavaWildcardTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashTypeContent({
      kind: 'JAVA_WILDCARD',
      bound,
      boundHash: boundType?.irContentHash ?? null
    }),
    display,
    kind: 'JAVA_WILDCARD',
    bound,
    boundType
  };
}

export function mkArray(
  elementType: JavaTypeIR,
  dimensions: number,
  isVararg: boolean,
  display: string
): JavaArrayTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashTypeContent({
      kind: 'JAVA_ARRAY',
      elementHash: elementType.irContentHash,
      dimensions,
      isVararg
    }),
    display,
    kind: 'JAVA_ARRAY',
    elementType,
    dimensions,
    isVararg
  };
}

export function mkTypeParam(name: string, display: string, upperBounds: ReadonlyArray<JavaTypeIR> = []): JavaTypeParameterIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashTypeContent({
      kind: 'JAVA_TYPE_PARAMETER',
      name,
      upperBounds: upperBounds.map(b => b.irContentHash)
    }),
    display,
    kind: 'JAVA_TYPE_PARAMETER',
    name,
    upperBounds
  };
}

export function mkUnsupported(display: string, reason: string): UnsupportedJavaTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashTypeContent({ kind: 'JAVA_UNSUPPORTED', reason, rawInput: display }),
    display,
    kind: 'JAVA_UNSUPPORTED',
    reason,
    rawInput: display
  };
}

function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '(') depth++;
    else if (c === '>' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function matchingAngleClose(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '<') depth++;
    else if (s[i] === '>') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stripArrayDims(s: string): { base: string; dims: number } {
  let base = s;
  let dims = 0;
  while (base.endsWith('[]')) {
    dims++;
    base = base.slice(0, -2).trimEnd();
  }
  return { base, dims };
}

function parseTypeInner(s: string): JavaTypeIR {
  if (s.endsWith('...')) {
    const elementRaw = s.slice(0, -3).trimEnd();
    if (!elementRaw) return mkUnsupported(s, 'VARARG_MISSING_ELEMENT_TYPE');
    const elementType = parseTypeInner(elementRaw);
    if (elementType.kind === 'JAVA_UNSUPPORTED') {
      return mkUnsupported(s, `VARARG_ELEMENT_UNSUPPORTED:${elementType.reason}`);
    }
    return mkArray(elementType, 1, true, s);
  }

  const { base: noArrayBase, dims } = stripArrayDims(s);
  if (dims > 0) {
    if (!noArrayBase) return mkUnsupported(s, 'ARRAY_MISSING_ELEMENT_TYPE');
    const elementType = parseTypeInner(noArrayBase);
    if (elementType.kind === 'JAVA_UNSUPPORTED') {
      return mkUnsupported(s, `ARRAY_ELEMENT_UNSUPPORTED:${elementType.reason}`);
    }
    return mkArray(elementType, dims, false, s);
  }

  if (s === '?') return mkWildcard('UNBOUNDED', undefined, s);

  if (s.startsWith('? extends ')) {
    const boundRaw = s.slice('? extends '.length).trim();
    if (!boundRaw) return mkUnsupported(s, 'WILDCARD_UPPER_BOUND_MISSING');
    const boundType = parseTypeInner(boundRaw);
    if (boundType.kind === 'JAVA_UNSUPPORTED') {
      return mkUnsupported(s, `WILDCARD_UPPER_BOUND_UNSUPPORTED:${boundType.reason}`);
    }
    return mkWildcard('UPPER', boundType, s);
  }

  if (s.startsWith('? super ')) {
    const boundRaw = s.slice('? super '.length).trim();
    if (!boundRaw) return mkUnsupported(s, 'WILDCARD_LOWER_BOUND_MISSING');
    const boundType = parseTypeInner(boundRaw);
    if (boundType.kind === 'JAVA_UNSUPPORTED') {
      return mkUnsupported(s, `WILDCARD_LOWER_BOUND_UNSUPPORTED:${boundType.reason}`);
    }
    return mkWildcard('LOWER', boundType, s);
  }

  if (s === 'void') return mkVoid(s);

  if (JAVA_PRIMITIVE_KINDS.has(s as JavaPrimitiveKind)) {
    return mkPrimitive(s as JavaPrimitiveKind, s);
  }

  const angleOpen = s.indexOf('<');
  if (angleOpen !== -1) {
    const baseName = s.slice(0, angleOpen).trim();
    if (!baseName || !/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(baseName)) {
      return mkUnsupported(s, 'MALFORMED_GENERIC_BASE_NAME');
    }

    const angleClose = matchingAngleClose(s, angleOpen);
    if (angleClose === -1 || angleClose !== s.length - 1) {
      return mkUnsupported(s, 'MALFORMED_GENERIC_UNBALANCED_BRACKETS');
    }

    const argsRaw = s.slice(angleOpen + 1, angleClose);
    if (!argsRaw.trim()) {
      return mkUnsupported(s, 'EMPTY_TYPE_ARGUMENT_LIST');
    }

    const argStrings = splitTopLevelCommas(argsRaw).map(a => a.trim());
    const args: JavaTypeIR[] = [];
    for (const argStr of argStrings) {
      if (!argStr) return mkUnsupported(s, 'EMPTY_TYPE_ARGUMENT');
      const arg = parseTypeInner(argStr);
      if (arg.kind === 'JAVA_UNSUPPORTED') {
        return mkUnsupported(s, `TYPE_ARGUMENT_UNSUPPORTED:${arg.reason}`);
      }
      args.push(arg);
    }
    return mkReference(baseName, args, s);
  }

  if (/^[A-Z]$/.test(s)) {
    return mkTypeParam(s, s);
  }

  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(s)) {
    return mkReference(s, [], s);
  }

  return mkUnsupported(s, 'UNRECOGNIZED_TYPE_FORM');
}

export function parseJavaTypeString(raw: string): JavaTypeIR {
  const trimmed = raw.trim();
  if (!trimmed) return mkUnsupported(raw, 'EMPTY_TYPE_STRING');
  return parseTypeInner(trimmed);
}
export function stripCommentsAndLiterals(source: string): string {
  const len = source.length;
  const out: string[] = [];
  let i = 0;

  while (i < len) {
    const ch = source[i];

    if (ch === '/' && source[i + 1] === '*') {
      let j = i + 2;
      while (j < len - 1 && !(source[j] === '*' && source[j + 1] === '/')) j++;
      j += 2;
      for (let k = i; k < j && k < len; k++) {
        out.push(source[k] === '\n' ? '\n' : ' ');
      }
      i = j;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      let j = i + 2;
      while (j < len && source[j] !== '\n') j++;
      for (let k = i; k < j; k++) out.push(' ');
      i = j;
      continue;
    }

    if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
      out.push('"', '"', '"');
      let j = i + 3;
      while (j < len - 2 && !(source[j] === '"' && source[j + 1] === '"' && source[j + 2] === '"')) {
        out.push(source[j] === '\n' ? '\n' : ' ');
        j++;
      }
      out.push('"', '"', '"');
      i = j + 3;
      continue;
    }

    if (ch === '"') {
      out.push('"');
      let j = i + 1;
      while (j < len && source[j] !== '"' && source[j] !== '\n') {
        if (source[j] === '\\') { out.push(' ', ' '); j += 2; continue; }
        out.push(' ');
        j++;
      }
      if (j < len && source[j] === '"') { out.push('"'); j++; }
      i = j;
      continue;
    }

    if (ch === "'") {
      out.push("'");
      let j = i + 1;
      while (j < len && source[j] !== "'" && source[j] !== '\n') {
        if (source[j] === '\\') { out.push(' ', ' '); j += 2; continue; }
        out.push(' ');
        j++;
      }
      if (j < len && source[j] === "'") { out.push("'"); j++; }
      i = j;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join('');
}

function visibilityFrom(modifiers: string): 'public' | 'protected' | 'package-private' | 'private' {
  if (/\bpublic\b/.test(modifiers)) return 'public';
  if (/\bprotected\b/.test(modifiers)) return 'protected';
  if (/\bprivate\b/.test(modifiers)) return 'private';
  return 'package-private';
}

function parseParameters(raw: string): JavaParameterIR[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const params: JavaParameterIR[] = [];
  const parts = splitTopLevelCommas(trimmed);

  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;

    const annotations: string[] = [];
    let rest = p;
    while (rest.startsWith('@')) {
      const match = rest.match(/^@([A-Za-z0-9_]+)(?:\([^)]*\))?\s*/);
      if (!match) break;
      annotations.push(match[1]);
      rest = rest.slice(match[0].length);
    }

    const isFinal = /^final\b/.test(rest);
    rest = rest.replace(/^final\s+/, '');

    const varargMatch = rest.match(/^([\w.<>\[\],\s]+?)\s*(\.\.\.)?\s+(\w+)$/);
    if (!varargMatch) {
      params.push({
        name: '',
        type: parseJavaTypeString(rest),
        isVararg: false,
        isFinal,
        annotations
      });
      continue;
    }

    const typeRaw = varargMatch[1].trim();
    const isVararg = !!varargMatch[2];
    const name = varargMatch[3];
    params.push({
      name,
      type: parseJavaTypeString(isVararg ? typeRaw + '...' : typeRaw),
      isVararg,
      isFinal,
      annotations
    });
  }

  return params;
}

export interface ParsedJavaFile {
  readonly filePath: string;
  readonly packageName: string;
  readonly imports: ReadonlyArray<JavaImportIR>;
  readonly classes: ReadonlyArray<JavaClassDeclIR>;
  readonly annotations: ReadonlyArray<string>;
  readonly callSites?: ReadonlyArray<JavaCallSiteIR>;
}
export class JavaTypeIRExtractor {
  public static parseJavaSource(filePath: string, source: string): ParsedJavaFile {
    const normPath = filePath.replace(/\\/g, '/');
    const stripped = stripCommentsAndLiterals(source);
    const strippedLines = stripped.split('\n');
    let packageName = '';
    const imports: JavaImportIR[] = [];
    const allFileAnnotations: string[] = [];

    // Match package declaration
    const pkgMatch = stripped.match(/\bpackage\s+([a-zA-Z0-9_.]+)\s*;/);
    if (pkgMatch) {
      packageName = pkgMatch[1];
    }

    // Match all imports across the file (supports multi-statement single lines)
    const importRegex = /\bimport\s+(?:(static)\s+)?([a-zA-Z0-9_.*]+)\s*;/g;
    let impMatch: RegExpExecArray | null;
    while ((impMatch = importRegex.exec(stripped)) !== null) {
      const isStatic = !!impMatch[1];
      const fullSpec = impMatch[2];
      const isWildcard = fullSpec.endsWith('.*');
      const parts = fullSpec.split('.');
      const importedName = isWildcard ? '*' : parts[parts.length - 1];
      const lineNum = stripped.slice(0, impMatch.index).split('\n').length;
      imports.push({ importedName, moduleSpecifier: fullSpec, isStatic, isWildcard, line: lineNum });
    }

    let currentAnnotations: string[] = [];
    for (let i = 0; i < strippedLines.length; i++) {
      const trimmed = strippedLines[i].trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

      const annoMatch = trimmed.match(/^@([a-zA-Z0-9_]+)(?:\([^)]*\))?/);
      if (annoMatch) {
        currentAnnotations.push(annoMatch[1]);
        allFileAnnotations.push(annoMatch[1]);
        continue;
      }

      if (!trimmed.startsWith('@')) {
        currentAnnotations = [];
      }
    }

    interface ClassScope {
      name: string;
      kind: 'class' | 'interface' | 'enum' | 'record';
      extendsName?: string;
      implementsNames: string[];
      annotations: string[];
      isExported: boolean;
      isAbstract: boolean;
      isFinal: boolean;
      isSealed?: boolean;
      permitsNames?: string[];
      lineStart: number;
      braceDepthAtStart: number;
      parentScope?: ClassScope;
      fields: JavaFieldIR[];
      methods: JavaMethodSignatureIR[];
    }

    const completedClasses: JavaClassDeclIR[] = [];
    const scopeStack: ClassScope[] = [];
    let currentBraceDepth = 0;
    let pendingAnnotations: string[] = [];
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;
      if (!trimmed) continue;

      const annoMatch = trimmed.match(/^@([a-zA-Z0-9_]+)(?:\([^)]*\))?\s*$/);
      if (annoMatch) {
        pendingAnnotations.push(annoMatch[1]);
        continue;
      }

      const classDeclMatch = trimmed.match(
        /(?:public|protected|private|abstract|final|static|sealed|non-sealed|\s)*\b(class|interface|enum|record)\s+([A-Za-z0-9_]+)(?:<[^>]+>)?(?:\s+extends\s+([A-Za-z0-9_.]+)(?:<[^>]+>)?)?(?:\s+implements\s+([A-Za-z0-9_.,\s<>]+))?(?:\s+permits\s+([A-Za-z0-9_.,\s<>]+))?/
      );

      if (classDeclMatch && !trimmed.startsWith('new ') && !trimmed.includes('.class')) {
        const kind = classDeclMatch[1] as 'class' | 'interface' | 'enum' | 'record';
        const name = classDeclMatch[2];
        const extendsName = classDeclMatch[3];
        const rawImplements = classDeclMatch[4];
        const rawPermits = classDeclMatch[5];
        const implementsNames = rawImplements
          ? rawImplements.split(',').map(s => s.trim().replace(/<.*>/, '')).filter(Boolean)
          : [];
        const permitsNames = rawPermits
          ? rawPermits.split(',').map(s => s.trim().replace(/<.*>/, '')).filter(Boolean)
          : [];
        const isSealed = /\bsealed\b/.test(trimmed) && !/\bnon-sealed\b/.test(trimmed);

        const initialFields: JavaFieldIR[] = [];
        if (kind === 'record') {
          const recordMatch = trimmed.match(/\brecord\s+[A-Za-z0-9_]+(?:<[^>]+>)?\s*\(([^)]*)\)/);
          if (recordMatch) {
            const rawParams = recordMatch[1];
            const parsedParams = parseParameters(rawParams);
            for (const param of parsedParams) {
              const partial = {
                name: param.name,
                type: param.type,
                visibility: 'public' as const,
                isStatic: false,
                isFinal: true,
                isVolatile: false,
                isTransient: false,
                annotations: [...param.annotations],
                line: lineNum
              };
              initialFields.push({ ...partial, irContentHash: computeJavaFieldHash(partial) });
            }
          }
        }

        const parentScope = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : undefined;
        scopeStack.push({
          name, kind, extendsName, implementsNames,
          annotations: [...pendingAnnotations],
          isExported: /\bpublic\b/.test(trimmed) || (parentScope !== undefined && /\bprotected\b/.test(trimmed)),
          isAbstract: /\babstract\b/.test(trimmed),
          isFinal: /\bfinal\b/.test(trimmed),
          isSealed,
          permitsNames,
          lineStart: lineNum,
          braceDepthAtStart: currentBraceDepth,
          parentScope,
          fields: initialFields, methods: []
        });
        pendingAnnotations = [];
      } else if (scopeStack.length > 0) {
        const currentScope = scopeStack[scopeStack.length - 1];
        if (currentScope.kind === 'enum' && !trimmed.startsWith('//') && !trimmed.startsWith('/*')) {
          const cleanLine = trimmed.replace(/;.*$/, '').trim();
          if (cleanLine.length > 0) {
            const tokens = cleanLine.split(',').map(s => s.trim().split(/\s|\(/)[0]).filter(s => /^[A-Za-z0-9_$]+$/.test(s) && !/^(?:public|protected|private|static|final|abstract|void|class|interface|enum|record|return)$/.test(s));
            for (const tok of tokens) {
              if (!currentScope.fields.some(f => f.name === tok)) {
                const partial = {
                  name: tok,
                  type: parseJavaTypeString(currentScope.name),
                  visibility: 'public' as const,
                  isStatic: true,
                  isFinal: true,
                  isVolatile: false,
                  isTransient: false,
                  annotations: [],
                  line: lineNum
                };
                currentScope.fields.push({ ...partial, irContentHash: computeJavaFieldHash(partial) });
              }
            }
          }
        }
        if (trimmed.includes('(') || (currentScope.kind === 'record' && trimmed.includes('{'))) {
          const method = this.tryExtractMethod(strippedLines, i, lineNum, pendingAnnotations, currentScope.name, currentScope.methods.length, currentScope);
          if (method) { currentScope.methods.push(method); pendingAnnotations = []; }
        } else if (this.looksLikeField(trimmed)) {
          const field = this.tryExtractField(trimmed, lineNum, pendingAnnotations);
          if (field) { currentScope.fields.push(field); pendingAnnotations = []; }
        }
      }

      for (const ch of line) {
        if (ch === '{') currentBraceDepth++;
        else if (ch === '}') {
          currentBraceDepth--;
          if (scopeStack.length > 0 && currentBraceDepth === scopeStack[scopeStack.length - 1].braceDepthAtStart) {
            const popped = scopeStack.pop()!;
            let binaryName = popped.name;
            let ancestor = popped.parentScope;
            while (ancestor) { binaryName = `${ancestor.name}$${binaryName}`; ancestor = ancestor.parentScope; }
            const fqcn = packageName ? `${packageName}.${binaryName.replace(/\$/g, '.')}` : binaryName.replace(/\$/g, '.');
            completedClasses.push({
              name: popped.name, fqcn, simpleName: popped.name,
              binaryName: packageName ? `${packageName}.${binaryName}` : binaryName,
              packageName, kind: popped.kind, extendsName: popped.extendsName, implementsNames: popped.implementsNames,
              fields: popped.fields, methods: popped.methods, annotations: popped.annotations,
              isExported: popped.isExported, isAbstract: popped.isAbstract, isFinal: popped.isFinal,
              isSealed: popped.isSealed, permitsNames: popped.permitsNames,
              lineStart: popped.lineStart, lineEnd: lineNum, filePath: normPath
            });
          }
        }
      }
      if (!trimmed.startsWith('@')) pendingAnnotations = [];
    }

    const structural=this.extractStructuralDeclarations(normPath,source,packageName,completedClasses);
    if(structural)completedClasses.splice(0,completedClasses.length,...structural);
    completedClasses.sort((a, b) => (a.fqcn < b.fqcn ? -1 : a.fqcn > b.fqcn ? 1 : 0));
    const callSites = this.extractCallSites(normPath, source, packageName, imports, completedClasses);

    // Attach callSites to classes and their methods
    const classesWithCallSites: JavaClassDeclIR[] = completedClasses.map(cls => {
      const classCallSites = callSites.filter(cs => cs.enclosingClassFqcn === cls.fqcn);
      const methodsWithCallSites = cls.methods.map(m => {
        const methodCallSites = classCallSites.filter(
          cs => (cs.enclosingMethodName === m.name || (m.isConstructor && cs.enclosingMethodName === '<init>')) ||
                (m.lineStart <= cs.line && cs.line <= m.lineEnd)
        );
        return { ...m, callSites: methodCallSites };
      });
      return {
        ...cls,
        methods: methodsWithCallSites,
        callSites: classCallSites
      };
    });

    classesWithCallSites.sort((a, b) => (a.fqcn < b.fqcn ? -1 : a.fqcn > b.fqcn ? 1 : 0));
    return { filePath: normPath, packageName, imports, classes: classesWithCallSites, annotations: allFileAnnotations, callSites };
  }
  private static extractStructuralDeclarations(filePath:string,source:string,packageName:string,legacy:JavaClassDeclIR[]):JavaClassDeclIR[]|undefined {
    const parser=getTreeSitterParser();if(!parser)return undefined;
    let tree:any;
    try {
      tree=parser.parse(source,undefined,{bufferSize:Math.max(32768,source.length*2+1024)});
      if(tree.rootNode.hasError)return undefined;
      const classes:JavaClassDeclIR[]=[];
      const modifiers=(node:any)=>node.namedChildren.find((child:any)=>child.type==='modifiers');
      const annotations=(node:any)=>(modifiers(node)?.namedChildren??[]).filter((child:any)=>['annotation','marker_annotation'].includes(child.type)).map((child:any)=>(child.childForFieldName('name')?.text??'').split('.').pop());
      const words=(node:any)=>(modifiers(node)?.children??[]).filter((child:any)=>!['annotation','marker_annotation'].includes(child.type)).map((child:any)=>child.text).join(' ');
      const visit=(node:any,parents:string[]=[])=>{
        if(['class_declaration','interface_declaration','enum_declaration','record_declaration'].includes(node.type)){
          const name=node.childForFieldName('name').text,chain=[...parents,name],binaryName=chain.join('$'),fqcn=[packageName,...chain].filter(Boolean).join('.');
          const prior=legacy.find(cls=>cls.fqcn===fqcn),kind=node.type.replace('_declaration','') as JavaClassDeclIR['kind'],flags=words(node);
          const fields:JavaFieldIR[]=kind==='record'?[...(prior?.fields??[])]:[],methods:JavaMethodSignatureIR[]=[];
          const body=node.childForFieldName('body');
          const members=(body?.namedChildren??[]).flatMap((member:any)=>member.type==='enum_body_declarations'?member.namedChildren:[member]);
          for(const member of members){
            if(kind==='enum'&&member.type==='enum_constant'){
              const partial={name:member.childForFieldName('name')?.text??member.namedChildren.find((child:any)=>child.type==='identifier')?.text,type:parseJavaTypeString(name),visibility:'public' as const,isStatic:true,isFinal:true,isVolatile:false,isTransient:false,isEnumConstant:true,annotations:annotations(member),line:member.startPosition.row+1};
              if(partial.name)fields.push({...partial,irContentHash:computeJavaFieldHash(partial)});
            }
            if(['method_declaration','constructor_declaration','compact_constructor_declaration'].includes(member.type)){
              const memberName=member.childForFieldName('name')?.text??name,memberFlags=words(member),isConstructor=member.type!=='method_declaration';
              const parameters:JavaParameterIR[]=(member.childForFieldName('parameters')?.namedChildren??[]).filter((parameter:any)=>['formal_parameter','spread_parameter'].includes(parameter.type)).map((parameter:any)=>{
                const declarator=parameter.namedChildren.find((child:any)=>child.type==='variable_declarator'),parameterName=parameter.childForFieldName('name')??declarator?.childForFieldName('name'),parameterType=parameter.childForFieldName('type')??parameter.namedChildren.find((child:any)=>child.type!=='modifiers'&&child.type!=='variable_declarator'&&child!==parameterName),dimensions=parameter.childForFieldName('dimensions')?.text??'';
                return {name:parameterName?.text??'',type:parseJavaTypeString((parameterType?.text??'<unresolved>')+dimensions+(parameter.type==='spread_parameter'?'...':'')),isVararg:parameter.type==='spread_parameter',isFinal:/\bfinal\b/.test(words(parameter)),annotations:annotations(parameter)};
              });
              const methodAnnotations=annotations(member),throws=member.namedChildren.find((child:any)=>child.type==='throws');
              for(const exception of throws?.namedChildren??[])methodAnnotations.push(`throws:${exception.text}`);
              if(/\bdefault\b/.test(memberFlags))methodAnnotations.push('default');
              if(member.type==='compact_constructor_declaration')methodAnnotations.push('compact_constructor');
              const partial={name:memberName,returnType:isConstructor?mkVoid(''):parseJavaTypeString(member.childForFieldName('type')?.text??'<unresolved>'),parameters:member.type==='compact_constructor_declaration'?fields.map(field=>({name:field.name,type:field.type,isVararg:false,isFinal:false,annotations:[]})):parameters,typeParameters:[],visibility:visibilityFrom(memberFlags),isStatic:/\bstatic\b/.test(memberFlags),isFinal:/\bfinal\b/.test(memberFlags),isAbstract:/\babstract\b/.test(memberFlags),isConstructor,isDeclaredOverride:methodAnnotations.includes('Override'),annotations:methodAnnotations,lineStart:(member.childForFieldName('name')??member).startPosition.row+1,lineEnd:member.endPosition.row+1,declarationOrdinal:methods.length};
              methods.push({...partial,irContentHash:computeJavaMethodHash(partial)});
            }
            if(member.type==='field_declaration'){
              const type=member.childForFieldName('type')?.text,flags=words(member);
              for(const declaration of member.namedChildren.filter((child:any)=>child.type==='variable_declarator')){
                const fieldName=declaration.childForFieldName('name')?.text,dimensions=declaration.childForFieldName('dimensions')?.text??'',initializer=declaration.childForFieldName('value')?.text;
                const parsed=this.tryExtractField(`${flags} ${type}${dimensions} ${fieldName}${initializer===undefined?'':` = ${initializer}`};`,(declaration.childForFieldName('name')??member).startPosition.row+1,annotations(member));if(parsed){const partial={...parsed,constantValue:initializer};fields.push({...partial,irContentHash:computeJavaFieldHash(partial)});}
              }
            }
          }
          const supertype=node.childForFieldName('superclass')?.namedChildren[0]?.text;
          const interfaces=node.childForFieldName('interfaces')?.namedChildren.find((child:any)=>child.type==='type_list')?.namedChildren.map((child:any)=>child.text)??prior?.implementsNames??[];
          classes.push({name,simpleName:name,fqcn,binaryName:packageName?`${packageName}.${binaryName}`:binaryName,packageName,kind,extendsName:supertype??prior?.extendsName,implementsNames:interfaces,fields,methods,annotations:annotations(node),isExported:/\bpublic\b/.test(flags),isAbstract:/\babstract\b/.test(flags),isFinal:/\bfinal\b/.test(flags),isSealed:/\bsealed\b/.test(flags)&&!flags.includes('non-sealed'),permitsNames:prior?.permitsNames,lineStart:node.startPosition.row+1,lineEnd:node.endPosition.row+1,filePath});
          for(const child of members)if(['class_declaration','interface_declaration','enum_declaration','record_declaration'].includes(child.type))visit(child,chain);
          return;
        }
        for(const child of node.namedChildren)visit(child,parents);
      };visit(tree.rootNode);return classes;
    } catch {return undefined;} finally {tree?.delete?.();}
  }

  private static looksLikeField(trimmed: string): boolean {
    if (!trimmed.endsWith(';')) return false;
    if (/^(?:return|throw|break|continue|assert|for|while|do|if|else|switch|case|default|import|package)\b/.test(trimmed)) return false;
    if (/^[A-Za-z_$][A-Za-z0-9_$.]*\s*\(/.test(trimmed)) return false;
    return /[A-Za-z_$][A-Za-z0-9_$.<>\[\]?,\s]+\s+[A-Za-z_$][A-Za-z0-9_$]*/.test(trimmed);
  }

  private static tryExtractField(trimmed: string, lineNum: number, annotations: string[]): JavaFieldIR | null {
    const pattern = /^((?:(?:public|protected|private|static|final|volatile|transient|synchronized)\s+)*)((?:[A-Za-z_$][A-Za-z0-9_$.<>\[\]?,\s]*?)\s+)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|;)/;
    const match = trimmed.match(pattern);
    if (!match) return null;

    const modifiers = match[1] || '';
    const rawType = match[2].trim();
    const name = match[3];
    if (/^(?:class|interface|enum|record|new|return|throw|else)$/.test(rawType)) return null;

    let constantValue: string | undefined = undefined;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      constantValue = trimmed.slice(eqIdx + 1).replace(/;.*$/, '').trim();
    }

    const partialField = {
      name,
      type: parseJavaTypeString(rawType),
      visibility: visibilityFrom(modifiers),
      isStatic: /\bstatic\b/.test(modifiers),
      isFinal: /\bfinal\b/.test(modifiers),
      isVolatile: /\bvolatile\b/.test(modifiers),
      isTransient: /\btransient\b/.test(modifiers),
      constantValue,
      annotations: [...annotations],
      line: lineNum
    };
    return { ...partialField, irContentHash: computeJavaFieldHash(partialField) };
  }

  private static tryExtractMethod(
    lines: string[], lineIdx: number, lineNum: number, annotations: string[], enclosingClassName: string, declarationOrdinal: number, currentScope?: any
  ): JavaMethodSignatureIR | null {
    // Check for record compact constructor at line start: public ClassName { ... } (no parentheses)
    const firstLineTrimmed = lines[lineIdx].trim();
    const compactMatch = firstLineTrimmed.match(/^((?:(?:public|protected|private)\s+)*)([A-Za-z0-9_$]+)\s*\{/);
    if (compactMatch && compactMatch[2] === enclosingClassName) {
      const modifiers = compactMatch[1] || '';
      const recordParams = (currentScope?.kind === 'record' && currentScope.fields)
        ? currentScope.fields.map((f: any) => ({
            name: f.name,
            type: f.type,
            isVararg: false,
            isFinal: false,
            annotations: []
          }))
        : [];
      const partialMethod = {
        name: enclosingClassName,
        returnType: mkVoid(''),
        parameters: recordParams,
        typeParameters: [],
        visibility: visibilityFrom(modifiers),
        isStatic: false,
        isFinal: false,
        isAbstract: false,
        isConstructor: true,
        isDeclaredOverride: false,
        annotations: [...annotations, 'compact_constructor'],
        lineStart: lineNum,
        lineEnd: lineNum,
        declarationOrdinal
      };
      return { ...partialMethod, irContentHash: computeJavaMethodHash(partialMethod) };
    }

    let combined = '';
    let endIdx = lineIdx;
    let parenDepth = 0;
    let foundOpen = false;
    let openParenIdx = -1;
    let closeParenIdx = -1;

    for (let k = lineIdx; k < Math.min(lines.length, lineIdx + 8); k++) {
      const l = lines[k];
      for (const ch of l) {
        if (ch === '(') {
          parenDepth++;
          if (!foundOpen) {
            foundOpen = true;
            openParenIdx = combined.length;
          }
        } else if (ch === ')') {
          parenDepth--;
          if (foundOpen && parenDepth === 0 && closeParenIdx === -1) {
            closeParenIdx = combined.length;
          }
        }
        combined += ch;
      }
      if (foundOpen && parenDepth === 0) { endIdx = k; break; }
      combined += ' ';
    }
    if (!foundOpen || parenDepth !== 0 || openParenIdx === -1 || closeParenIdx === -1) return null;

    const beforeParen = combined.slice(0, openParenIdx).trim();
    const paramStr = combined.slice(openParenIdx + 1, closeParenIdx).trim();
    if (/^(?:if|while|for|switch|catch)\b/.test(beforeParen)) return null;

    const pattern = /^((?:(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default)\s+)*(?:<[^>]+>\s+)?)(?:([A-Za-z0-9_$.<>\[\]?,\s]+?)\s+)?([A-Za-z0-9_$]+)$/;
    const mMatch = beforeParen.match(pattern);
    if (!mMatch) return null;

    const modifiers = mMatch[1] || '';
    const rawReturnType = mMatch[2]?.trim();
    const name = mMatch[3];
    const isConstructor = name === enclosingClassName && !rawReturnType;
    if (!rawReturnType && !isConstructor) return null;

    const afterParen = combined.slice(closeParenIdx + 1).trim();
    const throwsMatch = afterParen.match(/^throws\s+([A-Za-z0-9_$.<>,\s]+?)(?:\{|;|$)/);
    const methodAnnotations = [...annotations];
    if (/\bdefault\b/.test(modifiers)) {
      methodAnnotations.push('default');
    }
    if (throwsMatch) {
      const throwsList = throwsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const t of throwsList) {
        methodAnnotations.push(`throws:${t}`);
      }
    }

    const partialMethod = {
      name,
      returnType: isConstructor ? mkVoid('') : parseJavaTypeString(rawReturnType),
      parameters: parseParameters(paramStr),
      typeParameters: [],
      visibility: visibilityFrom(modifiers),
      isStatic: /\bstatic\b/.test(modifiers),
      isFinal: /\bfinal\b/.test(modifiers),
      isAbstract: /\babstract\b/.test(modifiers),
      isConstructor,
      isDeclaredOverride: annotations.includes('Override'),
      annotations: methodAnnotations,
      lineStart: lineNum,
      lineEnd: endIdx + 1,
      declarationOrdinal
    };
    return { ...partialMethod, irContentHash: computeJavaMethodHash(partialMethod) };
  }

  public static extractCallSites(
    filePath: string,
    source: string,
    packageName: string,
    imports: ReadonlyArray<JavaImportIR>,
    classes: ReadonlyArray<JavaClassDeclIR>
  ): JavaCallSiteIR[] {
    const parser = getTreeSitterParser();
    if (parser) {
      try {
        return this.walkTreeSitterCallSites(filePath, source, packageName, imports, classes, parser);
      } catch {
        // Fall back gracefully to regex walker
      }
    }
    return this.walkFallbackCallSites(filePath, source, packageName, imports, classes);
  }

  private static walkTreeSitterCallSites(
    filePath: string,
    source: string,
    packageName: string,
    imports: ReadonlyArray<JavaImportIR>,
    classes: ReadonlyArray<JavaClassDeclIR>,
    parser: any
  ): JavaCallSiteIR[] {
    const tree = parser.parse(source);
    const callSites: JavaCallSiteIR[] = [];

    const importMap = new Map<string, string>();
    const staticImports = new Map<string, string>();
    for (const imp of imports) {
      if (imp.isStatic) {
        if (!imp.isWildcard) {
          const parts = imp.moduleSpecifier.split('.');
          const member = parts.pop()!;
          staticImports.set(member, parts.join('.'));
        }
      } else if (!imp.isWildcard) {
        importMap.set(imp.importedName, imp.moduleSpecifier);
      }
    }

    const localClassMap = new Map<string, JavaClassDeclIR>();
    for (const c of classes) {
      localClassMap.set(c.name, c);
      localClassMap.set(c.simpleName, c);
    }

    const classStack: string[] = [];
    let currentMethodName = '<class>';

    function resolveTarget(
      receiverText: string | undefined,
      calleeName: string,
      currentClassFqcn: string,
      currentClass?: JavaClassDeclIR,
      localVars?: ReadonlyMap<string, string>
    ): { evidenceKind: 'STATIC_AST' | 'HEURISTIC'; resolvedTargetFqcn?: string } {
      if (!receiverText) {
        if (staticImports.has(calleeName)) {
          return { evidenceKind: 'STATIC_AST', resolvedTargetFqcn: staticImports.get(calleeName) };
        }
        return { evidenceKind: 'STATIC_AST', resolvedTargetFqcn: currentClassFqcn };
      }

      if (receiverText === 'this') {
        return { evidenceKind: 'STATIC_AST', resolvedTargetFqcn: currentClassFqcn };
      }

      if (receiverText === 'super') {
        if (currentClass?.extendsName) {
          const superSimple = currentClass.extendsName.split('.').pop() ?? currentClass.extendsName;
          const superFqcn = importMap.get(superSimple) ?? (localClassMap.get(superSimple)?.fqcn ?? (packageName ? `${packageName}.${superSimple}` : superSimple));
          return { evidenceKind: 'STATIC_AST', resolvedTargetFqcn: superFqcn };
        }
        return { evidenceKind: 'STATIC_AST', resolvedTargetFqcn: currentClassFqcn };
      }

      if (importMap.has(receiverText)) {
        return { evidenceKind: 'STATIC_AST', resolvedTargetFqcn: importMap.get(receiverText) };
      }

      if (localClassMap.has(receiverText)) {
        return { evidenceKind: 'STATIC_AST', resolvedTargetFqcn: localClassMap.get(receiverText)!.fqcn };
      }

      if (/^[A-Z]/.test(receiverText)) {
        const potentialFqcn = packageName ? `${packageName}.${receiverText}` : receiverText;
        return { evidenceKind: 'STATIC_AST', resolvedTargetFqcn: potentialFqcn };
      }

      if (receiverText.includes('.') && /^[a-z][a-z0-9_.]*\.[A-Z]/.test(receiverText)) {
        return { evidenceKind: 'STATIC_AST', resolvedTargetFqcn: receiverText };
      }

      if (localVars && localVars.has(receiverText)) {
        const rawType = localVars.get(receiverText)!;
        const cleanType = rawType.split('<')[0].trim();
        const simpleName = cleanType.split('.').pop() ?? cleanType;
        let targetFqcn = importMap.get(simpleName);
        if (!targetFqcn) {
          if (localClassMap.has(simpleName)) {
            targetFqcn = localClassMap.get(simpleName)!.fqcn;
          } else {
            for (const imp of imports) {
              if (imp.isWildcard && !imp.isStatic) {
                targetFqcn = `${imp.moduleSpecifier.replace(/\.\*$/, '')}.${simpleName}`;
                break;
              }
            }
            if (!targetFqcn && packageName) {
              targetFqcn = `${packageName}.${simpleName}`;
            }
          }
        }
        return { evidenceKind: 'HEURISTIC', resolvedTargetFqcn: targetFqcn ?? simpleName };
      }

      if (currentClass) {
        const field = currentClass.fields.find(f => f.name === receiverText);
        const method = currentClass.methods.find(m => m.name === currentMethodName);
        const param = method?.parameters.find(p => p.name === receiverText);
        const targetType = field?.type ?? param?.type;
        if (targetType && targetType.kind === 'JAVA_REFERENCE') {
          const typeName = targetType.simpleName;
          let targetFqcn = importMap.get(typeName);
          if (!targetFqcn) {
            for (const imp of imports) {
              if (imp.isWildcard && !imp.isStatic) {
                targetFqcn = `${imp.moduleSpecifier.replace(/\.\*$/, '')}.${typeName}`;
                break;
              }
            }
          }
          if (!targetFqcn && packageName) {
            targetFqcn = `${packageName}.${typeName}`;
          }
          return { evidenceKind: 'HEURISTIC', resolvedTargetFqcn: targetFqcn ?? typeName };
        }
      }

      return { evidenceKind: 'HEURISTIC' };
    }

    function walkNode(node: any, localVars: Map<string, string>): void {
      const isClassNode =
        node.type === 'class_declaration' ||
        node.type === 'interface_declaration' ||
        node.type === 'enum_declaration' ||
        node.type === 'record_declaration';

      let pushedClass = false;
      const prevMethod = currentMethodName;
      let scopeVars = localVars;

      if (isClassNode) {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          classStack.push(nameNode.text);
          pushedClass = true;
        }
      } else if (node.type === 'method_declaration') {
        const nameNode = node.childForFieldName('name');
        currentMethodName = nameNode ? nameNode.text : '<method>';
        scopeVars = new Map<string, string>();
      } else if (node.type === 'constructor_declaration') {
        currentMethodName = '<init>';
        scopeVars = new Map<string, string>();
      } else if (node.type === 'local_variable_declaration') {
        const typeNode = node.childForFieldName('type');
        const typeText = typeNode ? typeNode.text : '';
        if (typeText) {
          for (let i = 0; i < node.namedChildCount; i++) {
            const child = node.namedChild(i);
            if (child.type === 'variable_declarator') {
              const nameNode = child.childForFieldName('name');
              if (nameNode) {
                let resolvedType = typeText;
                if (typeText === 'var') {
                  const valNode = child.childForFieldName('value');
                  if (valNode && valNode.type === 'object_creation_expression') {
                    const ctorTypeNode = valNode.childForFieldName('type');
                    if (ctorTypeNode) resolvedType = ctorTypeNode.text;
                  }
                }
                scopeVars.set(nameNode.text, resolvedType);
              }
            }
          }
        }
      }

      const enclosingClassSimple = classStack.length > 0 ? classStack[classStack.length - 1] : '';
      const binaryName = classStack.join('$');
      const enclosingClassFqcn = packageName
        ? (binaryName ? `${packageName}.${binaryName.replace(/\$/g, '.')}` : packageName)
        : binaryName.replace(/\$/g, '.');
      const currentClassDecl = localClassMap.get(enclosingClassSimple);

      if (node.type === 'method_invocation') {
        const nameNode = node.childForFieldName('name');
        const objectNode = node.childForFieldName('object');
        const argsNode = node.childForFieldName('arguments');
        const calleeName = nameNode ? nameNode.text : '';
        const receiverText = objectNode ? objectNode.text : undefined;
        const argumentCount = argsNode ? argsNode.namedChildCount : 0;
        const line = node.startPosition.row + 1;
        const column = node.startPosition.column + 1;

        if (calleeName) {
          const { evidenceKind, resolvedTargetFqcn } = resolveTarget(receiverText, calleeName, enclosingClassFqcn, currentClassDecl, scopeVars);
          callSites.push({
            enclosingClassFqcn,
            enclosingMethodName: currentMethodName,
            calleeName,
            receiverText,
            argumentCount,
            line,
            column,
            callKind: 'METHOD_CALL',
            evidenceKind,
            resolvedTargetFqcn,
            rawText: node.text
          });
        }
      } else if (node.type === 'object_creation_expression') {
        const typeNode = node.childForFieldName('type');
        const argsNode = node.childForFieldName('arguments');
        const typeName = typeNode ? typeNode.text : '';
        const argumentCount = argsNode ? argsNode.namedChildCount : 0;
        const line = node.startPosition.row + 1;
        const column = node.startPosition.column + 1;

        if (typeName) {
          const simpleName = typeName.split('.').pop() ?? typeName;
          let resolvedTargetFqcn = importMap.get(simpleName);
          if (!resolvedTargetFqcn) {
            if (localClassMap.has(simpleName)) {
              resolvedTargetFqcn = localClassMap.get(simpleName)!.fqcn;
            } else {
              for (const imp of imports) {
                if (imp.isWildcard && !imp.isStatic) {
                  resolvedTargetFqcn = `${imp.moduleSpecifier.replace(/\.\*$/, '')}.${simpleName}`;
                  break;
                }
              }
              if (!resolvedTargetFqcn && packageName) {
                resolvedTargetFqcn = `${packageName}.${simpleName}`;
              }
            }
          }
          callSites.push({
            enclosingClassFqcn,
            enclosingMethodName: currentMethodName,
            calleeName: '<init>',
            receiverText: typeName,
            argumentCount,
            line,
            column,
            callKind: 'CONSTRUCTOR_CALL',
            evidenceKind: 'STATIC_AST',
            resolvedTargetFqcn: resolvedTargetFqcn ?? simpleName,
            rawText: node.text
          });
        }
      } else if (node.type === 'method_reference') {
        const line = node.startPosition.row + 1;
        const column = node.startPosition.column + 1;
        const firstChild = node.namedChild(0);
        const secondChild = node.namedChild(1);
        const receiverText = firstChild ? firstChild.text : undefined;
        const calleeName = secondChild ? secondChild.text : (node.text.split('::')[1] ?? '');
        const isConstructor = calleeName === 'new';

        if (receiverText && calleeName) {
          const isUpper = /^[A-Z]/.test(receiverText);
          const evidenceKind: 'STATIC_AST' | 'HEURISTIC' = isUpper ? 'STATIC_AST' : 'HEURISTIC';
          const simpleName = receiverText.split('.').pop() ?? receiverText;
          let resolvedTargetFqcn = isUpper
            ? (importMap.get(simpleName) ?? localClassMap.get(simpleName)?.fqcn)
            : undefined;
          if (isUpper && !resolvedTargetFqcn) {
            for (const imp of imports) {
              if (imp.isWildcard && !imp.isStatic) {
                resolvedTargetFqcn = `${imp.moduleSpecifier.replace(/\.\*$/, '')}.${simpleName}`;
                break;
              }
            }
            if (!resolvedTargetFqcn && packageName) {
              resolvedTargetFqcn = `${packageName}.${simpleName}`;
            }
          }

          if (!resolvedTargetFqcn && scopeVars && scopeVars.has(receiverText)) {
            const rawType = scopeVars.get(receiverText)!;
            const cleanType = rawType.split('<')[0].trim();
            const typeSimple = cleanType.split('.').pop() ?? cleanType;
            resolvedTargetFqcn = importMap.get(typeSimple) ?? (localClassMap.get(typeSimple)?.fqcn ?? (packageName ? `${packageName}.${typeSimple}` : typeSimple));
          }

          callSites.push({
            enclosingClassFqcn,
            enclosingMethodName: currentMethodName,
            calleeName: isConstructor ? '<init>' : calleeName,
            receiverText,
            argumentCount: 0,
            line,
            column,
            callKind: isConstructor ? 'CONSTRUCTOR_REFERENCE' : 'METHOD_REFERENCE',
            evidenceKind,
            resolvedTargetFqcn,
            rawText: node.text
          });
        }
      } else if (node.type === 'field_access') {
        const objectNode = node.childForFieldName('object');
        const fieldNode = node.childForFieldName('field');
        const calleeName = fieldNode ? fieldNode.text : '';
        const receiverText = objectNode ? objectNode.text : undefined;
        const line = node.startPosition.row + 1;
        const column = node.startPosition.column + 1;

        if (calleeName && receiverText && receiverText !== 'this' && receiverText !== 'super') {
          const isUpper = /^[A-Z]/.test(receiverText);
          const evidenceKind: 'STATIC_AST' | 'HEURISTIC' = isUpper ? 'STATIC_AST' : 'HEURISTIC';
          const simpleName = receiverText.split('.').pop() ?? receiverText;
          let resolvedTargetFqcn = isUpper
            ? (importMap.get(simpleName) ?? localClassMap.get(simpleName)?.fqcn)
            : undefined;
          if (isUpper && !resolvedTargetFqcn) {
            for (const imp of imports) {
              if (imp.isWildcard && !imp.isStatic) {
                resolvedTargetFqcn = `${imp.moduleSpecifier.replace(/\.\*$/, '')}.${simpleName}`;
                break;
              }
            }
            if (!resolvedTargetFqcn && packageName) {
              resolvedTargetFqcn = `${packageName}.${simpleName}`;
            }
          }

          if (!resolvedTargetFqcn && scopeVars && scopeVars.has(receiverText)) {
            const rawType = scopeVars.get(receiverText)!;
            const cleanType = rawType.split('<')[0].trim();
            const typeSimple = cleanType.split('.').pop() ?? cleanType;
            resolvedTargetFqcn = importMap.get(typeSimple) ?? (localClassMap.get(typeSimple)?.fqcn ?? (packageName ? `${packageName}.${typeSimple}` : typeSimple));
          }

          callSites.push({
            enclosingClassFqcn,
            enclosingMethodName: currentMethodName,
            calleeName,
            receiverText,
            argumentCount: 0,
            line,
            column,
            callKind: 'FIELD_ACCESS',
            evidenceKind,
            resolvedTargetFqcn,
            rawText: node.text
          });
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        walkNode(node.namedChild(i), scopeVars);
      }

      if (pushedClass) {
        classStack.pop();
      }
      currentMethodName = prevMethod;
    }

    walkNode(tree.rootNode, new Map<string, string>());
    return callSites;
  }

  private static walkFallbackCallSites(
    filePath: string,
    source: string,
    packageName: string,
    imports: ReadonlyArray<JavaImportIR>,
    classes: ReadonlyArray<JavaClassDeclIR>
  ): JavaCallSiteIR[] {
    const callSites: JavaCallSiteIR[] = [];
    const lines = source.split('\n');

    const importMap = new Map<string, string>();
    for (const imp of imports) {
      if (!imp.isStatic && !imp.isWildcard) {
        importMap.set(imp.importedName, imp.moduleSpecifier);
      }
    }

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const lineNum = idx + 1;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

      const enclosingClass = classes.find(c => c.lineStart <= lineNum && lineNum <= c.lineEnd) ?? classes[0];
      const enclosingClassFqcn = enclosingClass ? enclosingClass.fqcn : packageName;
      const enclosingMethod = enclosingClass?.methods.find(m => m.lineStart <= lineNum && lineNum <= m.lineEnd);
      const enclosingMethodName = enclosingMethod ? enclosingMethod.name : '<class>';

      const newMatches = trimmed.matchAll(/\bnew\s+([A-Za-z0-9_$.]+)\s*\(([^)]*)\)/g);
      for (const m of newMatches) {
        const typeName = m[1];
        const argsStr = m[2].trim();
        const argCount = argsStr.length === 0 ? 0 : argsStr.split(',').length;
        const simpleName = typeName.split('.').pop() ?? typeName;
        const resolvedTargetFqcn = importMap.get(simpleName) ?? (packageName ? `${packageName}.${simpleName}` : simpleName);
        callSites.push({
          enclosingClassFqcn,
          enclosingMethodName,
          calleeName: '<init>',
          receiverText: typeName,
          argumentCount: argCount,
          line: lineNum,
          callKind: 'CONSTRUCTOR_CALL',
          evidenceKind: 'STATIC_AST',
          resolvedTargetFqcn,
          rawText: m[0]
        });
      }

      const callMatches = trimmed.matchAll(/\b([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)\s*\(([^)]*)\)/g);
      for (const m of callMatches) {
        const receiverText = m[1];
        const calleeName = m[2];
        const argsStr = m[3].trim();
        const argCount = argsStr.length === 0 ? 0 : argsStr.split(',').length;
        if (/^(?:if|while|for|switch|catch|return)$/.test(receiverText)) continue;
        const isUpper = /^[A-Z]/.test(receiverText);
        const evidenceKind: 'STATIC_AST' | 'HEURISTIC' = isUpper ? 'STATIC_AST' : 'HEURISTIC';
        let resolvedTargetFqcn: string | undefined;
        if (isUpper) {
          resolvedTargetFqcn = importMap.get(receiverText) ?? (packageName ? `${packageName}.${receiverText}` : receiverText);
        } else if (enclosingClass) {
          const field = enclosingClass.fields.find(f => f.name === receiverText);
          const method = enclosingClass.methods.find(m => m.name === enclosingMethodName);
          const param = method?.parameters.find(p => p.name === receiverText);
          const targetType = field?.type ?? param?.type;
          if (targetType && targetType.kind === 'JAVA_REFERENCE') {
            const typeName = targetType.simpleName;
            let targetFqcn = importMap.get(typeName);
            if (!targetFqcn) {
              for (const imp of imports) {
                if (imp.isWildcard && !imp.isStatic) {
                  targetFqcn = `${imp.moduleSpecifier.replace(/\.\*$/, '')}.${typeName}`;
                  break;
                }
              }
            }
            resolvedTargetFqcn = targetFqcn ?? (packageName ? `${packageName}.${typeName}` : typeName);
          }
        }

        callSites.push({
          enclosingClassFqcn,
          enclosingMethodName,
          calleeName,
          receiverText,
          argumentCount: argCount,
          line: lineNum,
          callKind: 'METHOD_CALL',
          evidenceKind,
          resolvedTargetFqcn,
          rawText: m[0]
        });
      }
    }

    return callSites;
  }

  public static extractTypeIR(node: JavaASTNode): JavaTypeIR {
    if (node.kind === 'TYPE') return node.typeIR;
    if (node.kind === 'USAGE') return node.expectedType;
    if (node.kind === 'DECLARATION') {
      if (node.declarationKind === 'METHOD' || node.declarationKind === 'CONSTRUCTOR') return node.method.returnType;
      if (node.declarationKind === 'FIELD') return node.field.type;
      if (node.declarationKind === 'CLASS' || node.declarationKind === 'INTERFACE' ||
          node.declarationKind === 'ENUM'  || node.declarationKind === 'RECORD') {
        return mkReference(node.decl.fqcn, [], node.decl.name);
      }
    }
    return mkUnsupported('unknown_node', 'UNRECOGNIZED_AST_NODE');
  }
}

let treeSitterParserInstance: any = null;
let treeSitterAttempted = false;

function getTreeSitterParser(): any {
  if (!treeSitterAttempted) {
    treeSitterAttempted = true;
    try {
      const Parser = require('tree-sitter');
      const Java = require('tree-sitter-java');
      const p = new Parser();
      p.setLanguage(Java);
      treeSitterParserInstance = p;
    } catch {
      treeSitterParserInstance = null;
    }
  }
  return treeSitterParserInstance;
}


