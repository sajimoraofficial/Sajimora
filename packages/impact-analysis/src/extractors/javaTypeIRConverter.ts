/**
 * @file javaTypeIRConverter.ts
 * J-2: Converts raw Java type strings (from J-1 JavaRoleExtractor) into JavaTypeIR nodes.
 *
 * This is the only file that contains type-string parsing logic.
 * It depends on @sajimora/core for type definitions and canonicalJson.
 * No JVM, JavaParser, or JDT dependency.
 *
 * Supported input forms (from J-1 raw output):
 *  - Primitives:        int, long, double, float, boolean, byte, char, short
 *  - Void:              void
 *  - References:        String, Order, java.util.List
 *  - Generics:          List<String>, Map<String, List<Order>>
 *  - Arrays:            int[], String[][]
 *  - Varargs:           String..., int...
 *  - Wildcards:         ?, ? extends Number, ? super Integer
 *  - Type parameters:   T, E, K  (heuristic: single uppercase letter)
 *  - Nested combos:     Map<String, List<Order>[]>, ? extends List<String>
 *
 * Unsupported forms fail closed → UnsupportedJavaTypeIR (never silently succeed).
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

// ─── Hash computation ─────────────────────────────────────────────────────────

/**
 * Computes the deterministic irContentHash for a Java type IR node.
 * The hash domain prefix isolates Java IR from TypeScript IR namespaces.
 * display and schemaVersion are intentionally excluded so that whitespace
 * variations in the source text do not affect the hash.
 */
function hashContent(content: object): string {
  return crypto
    .createHash('sha256')
    .update('SAJIMORA_JAVA_TYPE_IR_V1\0' + canonicalJson(content), 'utf8')
    .digest('hex');
}

// ─── IR node constructors ─────────────────────────────────────────────────────

function mkPrimitive(kind: JavaPrimitiveKind, display: string): JavaPrimitiveTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashContent({ kind: 'JAVA_PRIMITIVE', primitiveKind: kind }),
    display,
    kind: 'JAVA_PRIMITIVE',
    primitiveKind: kind
  };
}

function mkVoid(display: string): JavaVoidTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashContent({ kind: 'JAVA_VOID' }),
    display,
    kind: 'JAVA_VOID'
  };
}

function mkReference(
  qualifiedName: string,
  typeArguments: ReadonlyArray<JavaTypeIR>,
  display: string
): JavaReferenceTypeIR {
  const segments = qualifiedName.split('.');
  const simpleName = segments[segments.length - 1];
  const isFullyQualified = segments.length > 1;
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashContent({
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

function mkWildcard(
  bound: 'UNBOUNDED' | 'UPPER' | 'LOWER',
  boundType: JavaTypeIR | undefined,
  display: string
): JavaWildcardTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashContent({
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

function mkArray(
  elementType: JavaTypeIR,
  dimensions: number,
  isVararg: boolean,
  display: string
): JavaArrayTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashContent({
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

function mkTypeParam(
  name: string,
  display: string
): JavaTypeParameterIR {
  // J-2: upperBounds always empty at use-site; populated in J-3
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashContent({ kind: 'JAVA_TYPE_PARAMETER', name, upperBounds: [] }),
    display,
    kind: 'JAVA_TYPE_PARAMETER',
    name,
    upperBounds: []
  };
}

function mkUnsupported(display: string, reason: string): UnsupportedJavaTypeIR {
  return {
    schemaVersion: JAVA_TYPE_IR_SCHEMA_VERSION,
    irContentHash: hashContent({ kind: 'JAVA_UNSUPPORTED', reason, rawInput: display }),
    display,
    kind: 'JAVA_UNSUPPORTED',
    reason,
    rawInput: display
  };
}

// ─── Bracket / angle utilities ────────────────────────────────────────────────

/** Returns the index of the first `<` in `s`, or -1 if absent. */
function indexOfAngleOpen(s: string): number {
  return s.indexOf('<');
}

/**
 * Returns the index of the `>` that closes the `<` at `openIdx` in `s`,
 * tracking nested `<>` and `()`.  Returns -1 if unbalanced.
 */
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

/**
 * Splits `s` on commas that are NOT nested inside `<>` or `()`.
 * Used to separate type arguments: `String, Map<K, V>` → `["String", "Map<K, V>"]`.
 */
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

/**
 * Strips trailing `[]` pairs from `s`, returning the base type string and
 * the number of dimensions stripped.
 */
function stripArrayDims(s: string): { base: string; dims: number } {
  let base = s;
  let dims = 0;
  // Must work from right to left on trimmed string
  while (base.endsWith('[]')) {
    dims++;
    base = base.slice(0, -2).trimEnd();
  }
  return { base, dims };
}

// ─── Core recursive parser ────────────────────────────────────────────────────

/**
 * Recursively parses a raw Java type string into a JavaTypeIR node.
 * Input is expected to be trimmed.  Whitespace inside generic brackets is
 * normalized so that `List< String >` and `List<String>` produce the same hash.
 */
function parseTypeInner(s: string): JavaTypeIR {
  // ── 1. Varargs: String... ─────────────────────────────────────────────────
  if (s.endsWith('...')) {
    const elementRaw = s.slice(0, -3).trimEnd();
    if (!elementRaw) return mkUnsupported(s, 'VARARG_MISSING_ELEMENT_TYPE');
    const elementType = parseTypeInner(elementRaw);
    if (elementType.kind === 'JAVA_UNSUPPORTED') {
      return mkUnsupported(s, `VARARG_ELEMENT_UNSUPPORTED:${elementType.reason}`);
    }
    return mkArray(elementType, 1, true, s);
  }

  // ── 2. Array brackets: int[], String[][] ─────────────────────────────────
  const { base: noArrayBase, dims } = stripArrayDims(s);
  if (dims > 0) {
    if (!noArrayBase) return mkUnsupported(s, 'ARRAY_MISSING_ELEMENT_TYPE');
    const elementType = parseTypeInner(noArrayBase);
    if (elementType.kind === 'JAVA_UNSUPPORTED') {
      return mkUnsupported(s, `ARRAY_ELEMENT_UNSUPPORTED:${elementType.reason}`);
    }
    return mkArray(elementType, dims, false, s);
  }

  // ── 3. Wildcard: ?, ? extends T, ? super T ───────────────────────────────
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

  // ── 4. void ───────────────────────────────────────────────────────────────
  if (s === 'void') return mkVoid(s);

  // ── 5. Primitives ─────────────────────────────────────────────────────────
  if (JAVA_PRIMITIVE_KINDS.has(s as JavaPrimitiveKind)) {
    return mkPrimitive(s as JavaPrimitiveKind, s);
  }

  // ── 6. Generic reference: Name<...> ─────────────────────────────────────
  const angleOpen = indexOfAngleOpen(s);
  if (angleOpen !== -1) {
    // Validate: nothing before the < that looks like a keyword
    const baseName = s.slice(0, angleOpen).trim();
    if (!baseName || !/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(baseName)) {
      return mkUnsupported(s, 'MALFORMED_GENERIC_BASE_NAME');
    }

    const angleClose = matchingAngleClose(s, angleOpen);
    // The closing > must be the very last character of the string
    if (angleClose === -1 || angleClose !== s.length - 1) {
      return mkUnsupported(s, 'MALFORMED_GENERIC_UNBALANCED_BRACKETS');
    }

    const argsRaw = s.slice(angleOpen + 1, angleClose);
    // An empty <> is unsupported (diamond operator, not a type)
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

  // ── 7. Type parameter heuristic: single uppercase letter ─────────────────
  //    Convention in Java: T, E, K, V, R, N, S, A, B, etc.
  //    This is a use-site heuristic; bounds are not available here (J-2 scope).
  if (/^[A-Z]$/.test(s)) {
    return mkTypeParam(s, s);
  }

  // ── 8. Simple reference or FQCN ──────────────────────────────────────────
  //    Must be a valid Java identifier (possibly dotted for FQCN)
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(s)) {
    return mkReference(s, [], s);
  }

  // ── 9. Fail closed ────────────────────────────────────────────────────────
  return mkUnsupported(s, 'UNRECOGNIZED_TYPE_FORM');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parses a raw Java type string from J-1 output into a deterministic JavaTypeIR.
 *
 * The function is pure and stateless: same input always produces the same output
 * including the same irContentHash.
 *
 * Failure is always explicit: if the input cannot be classified, the result is
 * a UnsupportedJavaTypeIR (kind === 'JAVA_UNSUPPORTED').  The caller must treat
 * any JAVA_UNSUPPORTED node as INCOMPLETE / UNKNOWN — never as PRESERVED.
 *
 * @param raw  Raw type string as produced by JavaRoleExtractor (J-1).
 *             Leading and trailing whitespace is stripped before processing.
 */
export function parseJavaTypeString(raw: string): JavaTypeIR {
  const trimmed = raw.trim();
  if (!trimmed) return mkUnsupported(raw, 'EMPTY_TYPE_STRING');
  return parseTypeInner(trimmed);
}

/**
 * Converts all raw type strings in a J-1 JavaParseDetails structure into a
 * parallel structure where every type string is replaced by a JavaTypeIR.
 *
 * This is a convenience wrapper for callers that receive a full JavaParseDetails
 * and want the entire file's types converted in one call.
 *
 * Returns an array of typed descriptors: one per field, plus one per method
 * parameter and one for each method's return type.
 */
export interface JavaTypedField {
  fieldName: string;
  fieldType: JavaTypeIR;
  line: number;
}

export interface JavaTypedParameter {
  methodName: string;
  paramIndex: number;
  paramName: string;
  paramType: JavaTypeIR;
  isVararg: boolean;
}

export interface JavaTypedReturn {
  methodName: string;
  isConstructor: boolean;
  returnType: JavaTypeIR;
}

export interface JavaTypedExtraction {
  fields: ReadonlyArray<JavaTypedField>;
  parameters: ReadonlyArray<JavaTypedParameter>;
  returns: ReadonlyArray<JavaTypedReturn>;
}

export function convertJavaParseDetails(details: {
  fields: ReadonlyArray<{ name: string; type: string; line: number }>;
  methods: ReadonlyArray<{
    name: string;
    returnType: string;
    isConstructor: boolean;
    parameters: ReadonlyArray<{ name: string; type: string; isVararg: boolean }>;
  }>;
}): JavaTypedExtraction {
  const fields: JavaTypedField[] = details.fields.map(f => ({
    fieldName: f.name,
    fieldType: parseJavaTypeString(f.type),
    line: f.line
  }));

  const parameters: JavaTypedParameter[] = [];
  const returns: JavaTypedReturn[] = [];

  for (const m of details.methods) {
    returns.push({
      methodName: m.name,
      isConstructor: m.isConstructor,
      returnType: m.isConstructor ? mkVoid('') : parseJavaTypeString(m.returnType)
    });
    m.parameters.forEach((p, idx) => {
      parameters.push({
        methodName: m.name,
        paramIndex: idx,
        paramName: p.name,
        paramType: parseJavaTypeString(p.type),
        isVararg: p.isVararg
      });
    });
  }

  return { fields, parameters, returns };
}
