import { detectTestSignals } from './testSignalDetector';

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface JavaDecl {
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'record';
  isExported: boolean;
  hasConcreteBody: boolean;
  extendsName?: string;
  implementsNames: string[];
  annotations: string[];
  lineStart: number;
  lineEnd: number;
}

/**
 * J-1 addition: a single formal parameter extracted from a method signature.
 * Types are preserved as raw source strings (no JVM resolution yet).
 */
export interface JavaParameterDecl {
  /** Raw type string as written in source, e.g. "List<String>", "int", "String..." */
  type: string;
  /** Parameter name as written in source. */
  name: string;
  /** True when the parameter uses Java varargs syntax (`...`). */
  isVararg: boolean;
  /** Annotations present on the parameter, e.g. ["NonNull", "RequestParam"]. */
  annotations: string[];
}

/**
 * J-1 addition: a single field declaration extracted from a class body.
 */
export interface JavaFieldDecl {
  /** Field name. */
  name: string;
  /** Raw type string as written in source, e.g. "String", "List<Order>". */
  type: string;
  /** Visibility modifier. */
  visibility: 'public' | 'protected' | 'package-private' | 'private';
  /** True for `static` fields. */
  isStatic: boolean;
  /** True for `final` fields. */
  isFinal: boolean;
  /** True for `volatile` fields. */
  isVolatile: boolean;
  /** True for `transient` fields. */
  isTransient: boolean;
  /** Annotations collected above the field declaration, e.g. ["Column", "NotNull"]. */
  annotations: string[];
  /** 1-based line number of the field declaration. */
  line: number;
}

export interface JavaMethodDecl {
  name: string;
  /**
   * Raw return type string, e.g. "void", "List<Order>", "Optional<String>".
   * Always present for a matched method; empty string means void was not
   * written explicitly (constructor).
   */
  returnType: string;
  /** True for constructor declarations (name matches enclosing class). */
  isConstructor: boolean;
  isExported: boolean;
  visibility: 'public' | 'protected' | 'package-private' | 'private';
  hasConcreteBody: boolean;
  isDelegatingCall: boolean;
  delegatedTarget?: string;
  bodyLineCount: number;
  annotations: string[];
  /** J-1: formal parameters extracted from the signature. */
  parameters: JavaParameterDecl[];
  /**
   * J-1: True when the method has an explicit `@Override` annotation
   * immediately above it (not inherited from a parent-class annotation).
   */
  isDeclaredOverride: boolean;
  lineStart: number;
  lineEnd: number;
  bodyStatements: string[];
}

export interface JavaImport {
  importedName: string;
  moduleSpecifier: string;
  isStatic: boolean;
  isWildcard: boolean;
  line: number;
}

export interface JavaParseDetails {
  packageName: string;
  imports: JavaImport[];
  declarations: JavaDecl[];
  /** J-1: fields extracted from class bodies. */
  fields: JavaFieldDecl[];
  methods: JavaMethodDecl[];
  annotations: string[];
  isTestFile: boolean;
  isApiRoute: boolean;
  isDataSchema: boolean;
  isCoreService: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Strips single-line comments (`// …`), multi-line block comments (`/* … *\/`),
 * Javadoc comments (`/** … *\/`), double-quoted string literals, character
 * literals, and Java 15+ text blocks (`"""…"""`).
 *
 * The result preserves line count so that original line numbers remain valid.
 * The replacement for removed content is the same number of newline characters
 * that appeared in the removed span.
 */
function stripCommentsAndLiterals(source: string): string {
  const len = source.length;
  const out: string[] = [];
  let i = 0;

  while (i < len) {
    const ch = source[i];

    // Block comment or Javadoc: /* … */ or /** … */
    if (ch === '/' && source[i + 1] === '*') {
      let j = i + 2;
      while (j < len - 1 && !(source[j] === '*' && source[j + 1] === '/')) {
        j++;
      }
      j += 2; // consume closing */
      // Replace the whole comment with whitespace preserving newlines
      for (let k = i; k < j && k < len; k++) {
        out.push(source[k] === '\n' ? '\n' : ' ');
      }
      i = j;
      continue;
    }

    // Single-line comment: // …
    if (ch === '/' && source[i + 1] === '/') {
      let j = i + 2;
      while (j < len && source[j] !== '\n') j++;
      // Replace line content with spaces but keep the newline
      for (let k = i; k < j; k++) out.push(' ');
      i = j;
      continue;
    }

    // Java 15+ text block: """…"""
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

    // String literal: "…" (single line only after text-block check above)
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

    // Char literal: '…'
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

/**
 * Parses a method parameter list string such as:
 *   `String id, @NonNull List<String> items, int... counts`
 *
 * Returns an array of `JavaParameterDecl`. Handles:
 *  - Simple types (`int x`)
 *  - Generic types (`List<String> items`, `Map<String, List<Order>> map`)
 *  - Varargs (`String... args`)
 *  - Annotations on parameters (`@NonNull String name`)
 *  - `final` modifier
 */
function parseParameterList(raw: string): JavaParameterDecl[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const params: JavaParameterDecl[] = [];
  // Split on commas that are not inside angle brackets (generics)
  const parts = splitOnTopLevelCommas(trimmed);

  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;

    // Collect leading annotations
    const annotations: string[] = [];
    let rest = p;
    while (rest.startsWith('@')) {
      const annoMatch = rest.match(/^@([A-Za-z0-9_]+)(?:\([^)]*\))?\s*/);
      if (!annoMatch) break;
      annotations.push(annoMatch[1]);
      rest = rest.slice(annoMatch[0].length);
    }
    // Strip `final` modifier
    rest = rest.replace(/^final\s+/, '');

    // The last token is the name; everything before is the type
    // Handle varargs: `String... name` or `String ...name`
    const varargMatch = rest.match(/^([\w.<>\[\],\s]+?)\s*(\.\.\.)?\s+(\w+)$/);
    if (!varargMatch) {
      // Fallback: single token — treat as unresolvable
      params.push({ type: rest, name: '', isVararg: false, annotations });
      continue;
    }

    const typeRaw = varargMatch[1].trim();
    const isVararg = !!varargMatch[2];
    const name = varargMatch[3];
    params.push({
      type: isVararg ? typeRaw + '...' : typeRaw,
      name,
      isVararg,
      annotations
    });
  }

  return params;
}

/**
 * Splits a string on top-level commas (commas not nested inside `<…>` or `(…)`).
 */
function splitOnTopLevelCommas(s: string): string[] {
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
 * Given the modifiers string that precedes a method/field name (e.g.
 * `"public static final"`), derives the visibility.
 */
function visibilityFrom(modifiers: string): 'public' | 'protected' | 'package-private' | 'private' {
  if (/\bpublic\b/.test(modifiers)) return 'public';
  if (/\bprotected\b/.test(modifiers)) return 'protected';
  if (/\bprivate\b/.test(modifiers)) return 'private';
  return 'package-private';
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

/**
 * Matches a field declaration at the start of a stripped line.
 * Group 1: modifiers (may be empty)
 * Group 2: type (may include generics and array brackets)
 * Group 3: field name
 *
 * Does NOT match method declarations (those have a `(` after the name).
 * Does NOT match class/interface/enum/record declarations.
 *
 * Examples matched:
 *   private String id;
 *   public static final int MAX = 100;
 *   protected volatile List<Order> orders;
 *   private final Map<String, List<String>> cache;
 */
const FIELD_PATTERN = /^((?:(?:public|protected|private|static|final|volatile|transient|synchronized)\s+)*)((?:[A-Za-z_$][A-Za-z0-9_$.<>\[\]?,\s]*?)\s+)([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|;)/;

/**
 * Matches a method or constructor declaration at the start of a stripped line.
 *
 * Group 1: visibility/modifier tokens (may be empty)
 * Group 2: return type (absent for constructors — the token IS the name)
 * Group 3: method name
 * Group 4: raw parameter list (everything between the outermost `(` and `)`)
 *
 * Strategy: we detect the pattern `<modifiers> <returnType> <name> (` and
 * capture everything up to the matching `)`. Because we have already stripped
 * comments and string literals the parentheses should balance cleanly on a
 * single logical line (Java signatures do not span multiple source lines in
 * practice, and even when they do they are rare enough that we fall through
 * gracefully and emit no method).
 */
const METHOD_PATTERN = /^((?:(?:public|protected|private|static|final|abstract|synchronized|native|strictfp|default)\s+)*(?:(?:<[^>]*>\s+)?))((?:[A-Za-z_$][A-Za-z0-9_$.<>\[\]?,\s]*?)\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;

// ─── Main extractor class ─────────────────────────────────────────────────────

export class JavaRoleExtractor {
  /**
   * Deep structural parse of Java source code without external JVM dependencies.
   *
   * J-1 additions over the original:
   *  - `fields`  — all field declarations in class bodies
   *  - `JavaMethodDecl.parameters` — formal parameter list
   *  - `JavaMethodDecl.returnType` — always a string (empty for constructors)
   *  - `JavaMethodDecl.isConstructor` — true when the name matches the class
   *  - `JavaMethodDecl.isDeclaredOverride` — true when immediately preceded by @Override
   */
  public parseStructure(relPath: string, fileContent: string): JavaParseDetails {
    const normPath = relPath.replace(/\\/g, '/');
    const rawLines = fileContent.split('\n');

    let packageName = '';
    const imports: JavaImport[] = [];
    const declarations: JavaDecl[] = [];
    const fields: JavaFieldDecl[] = [];
    const methods: JavaMethodDecl[] = [];
    const allAnnotations: string[] = [];

    // 1. Detect test artifacts
    const genericTestResult = detectTestSignals(normPath, fileContent);
    let isTestFile = genericTestResult.isTestFile;

    // 2. Strip comments and string/char literals once for field/method scanning.
    //    rawLines is kept for import/package/class parsing (those patterns are
    //    safe on raw source); strippedLines is used for field/method extraction.
    const stripped = stripCommentsAndLiterals(fileContent);
    const strippedLines = stripped.split('\n');

    // ── Pass 1: package, imports, class/interface/enum/record, annotations ────
    //            (identical logic to original; operates on rawLines)
    let currentAnnotations: string[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        continue;
      }

      // Package
      const pkgMatch = trimmed.match(/^package\s+([a-zA-Z0-9_.]+)\s*;/);
      if (pkgMatch) {
        packageName = pkgMatch[1];
        continue;
      }

      // Import
      const importMatch = trimmed.match(/^import\s+(?:(static)\s+)?([a-zA-Z0-9_.*]+)\s*;/);
      if (importMatch) {
        const isStatic = !!importMatch[1];
        const fullSpec = importMatch[2];
        const isWildcard = fullSpec.endsWith('.*');
        const parts = fullSpec.split('.');
        const importedName = isWildcard ? '*' : parts[parts.length - 1];
        imports.push({ importedName, moduleSpecifier: fullSpec, isStatic, isWildcard, line: lineNum });
        continue;
      }

      // Annotation
      const annoMatch = trimmed.match(/^@([a-zA-Z0-9_]+)(?:\([^)]*\))?/);
      if (annoMatch) {
        const annoName = annoMatch[1];
        currentAnnotations.push(annoName);
        allAnnotations.push(annoName);
        if (/Test|TestCase|ParameterizedTest/i.test(annoName)) {
          isTestFile = true;
        }
        continue;
      }

      // Class / Interface / Enum / Record
      const declMatch = trimmed.match(
        /(?:public|protected|private|abstract|final|static|\s)*\b(class|interface|enum|record)\s+([A-Za-z0-9_]+)(?:<[^>]+>)?(?:\s+extends\s+([A-Za-z0-9_.]+)(?:<[^>]+>)?)?(?:\s+implements\s+([A-Za-z0-9_.,\s<>]+))?/
      );
      if (declMatch) {
        const kind = declMatch[1] as 'class' | 'interface' | 'enum' | 'record';
        const name = declMatch[2];
        const extendsName = declMatch[3];
        const rawImplements = declMatch[4];
        const implementsNames = rawImplements
          ? rawImplements.split(',').map(s => s.trim().replace(/<.*>/, '')).filter(Boolean)
          : [];
        declarations.push({
          name,
          kind,
          isExported: !trimmed.startsWith('private') && !trimmed.startsWith('protected'),
          hasConcreteBody: kind !== 'interface',
          extendsName,
          implementsNames,
          annotations: [...currentAnnotations],
          lineStart: lineNum,
          lineEnd: lineNum
        });
        currentAnnotations = [];
        continue;
      }

      if (!trimmed.startsWith('@')) {
        currentAnnotations = [];
      }
    }

    // ── Pass 2: field and method extraction on stripped lines ─────────────────
    //
    // We track brace depth to know when we are inside a class body (depth >= 1)
    // vs. at the top level. Annotations are re-accumulated on the stripped side.

    const knownClassNames = new Set(declarations.map(d => d.name));
    let braceDepth = 0;
    let pendingAnnotations: string[] = [];

    for (let i = 0; i < strippedLines.length; i++) {
      const sLine = strippedLines[i];
      const trimmed = sLine.trim();
      const lineNum = i + 1;

      if (!trimmed) continue;

      // Count brace changes on this line to track class-body depth
      for (const ch of sLine) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }

      // Annotation collection on stripped source
      const annoMatch = trimmed.match(/^@([a-zA-Z0-9_]+)(?:\([^)]*\))?\s*$/);
      if (annoMatch) {
        pendingAnnotations.push(annoMatch[1]);
        continue;
      }

      // Only extract members when inside at least one class body
      if (braceDepth < 1) {
        if (!trimmed.startsWith('@')) pendingAnnotations = [];
        continue;
      }

      // ── Method detection ──────────────────────────────────────────────────
      //
      // Strategy: find the opening `(` on this line, collect everything up
      // to the matching `)` (may span lines), then match against METHOD_PATTERN.
      if (trimmed.includes('(')) {
        const methodExtracted = this.tryExtractMethod(
          strippedLines, i, lineNum, pendingAnnotations, knownClassNames
        );
        if (methodExtracted) {
          methods.push(methodExtracted);
          pendingAnnotations = [];
          continue;
        }
      }

      // ── Field detection ───────────────────────────────────────────────────
      if (this.looksLikeField(trimmed)) {
        const fieldExtracted = this.tryExtractField(trimmed, lineNum, pendingAnnotations);
        if (fieldExtracted) {
          fields.push(fieldExtracted);
          pendingAnnotations = [];
          continue;
        }
      }

      // Non-annotation, non-blank line: reset pending annotations
      if (!trimmed.startsWith('@')) {
        pendingAnnotations = [];
      }
    }

    const isApiRoute = allAnnotations.some(a =>
      /^(?:RestController|Controller|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)$/.test(a)
    );
    const isDataSchema = allAnnotations.some(a =>
      /^(?:Entity|Table|Document|Embeddable)$/.test(a)
    );
    const isCoreService = allAnnotations.some(a =>
      /^(?:Service|Component|Repository|Configuration|Bean)$/.test(a)
    );

    return {
      packageName,
      imports,
      declarations,
      fields,
      methods,
      annotations: allAnnotations,
      isTestFile,
      isApiRoute,
      isDataSchema,
      isCoreService
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Returns true if a stripped, trimmed line looks like it could be a field
   * declaration (ends with `;` or `=` something `;`, is not a method call,
   * is not a for/while/if statement).
   */
  private looksLikeField(trimmed: string): boolean {
    // Must end with ; (after possible initialiser)
    if (!trimmed.endsWith(';')) return false;
    // Must not be a statement keyword
    if (/^(?:return|throw|break|continue|assert|for|while|do|if|else|switch|case|default)\b/.test(trimmed)) return false;
    // Must not be a method call (foo(...);)
    if (/^[A-Za-z_$][A-Za-z0-9_$.]*\s*\(/.test(trimmed)) return false;
    // Must have at least two tokens before `=` or `;`
    return /[A-Za-z_$][A-Za-z0-9_$.<>\[\]?,\s]+\s+[A-Za-z_$][A-Za-z0-9_$]*/.test(trimmed);
  }

  /**
   * Attempts to extract a `JavaFieldDecl` from a single stripped, trimmed line.
   * Returns null if the line does not match the field pattern.
   */
  private tryExtractField(
    trimmed: string,
    lineNum: number,
    annotations: string[]
  ): JavaFieldDecl | null {
    // Strip initialiser to simplify matching: everything after the first `=`
    // (outside of generic brackets) is not needed for the declaration shape.
    const noInit = trimmed.replace(/=.*$/, '').trim() + ';';

    const m = FIELD_PATTERN.exec(noInit);
    if (!m) return null;

    const modifiers = m[1].trim();
    const typeRaw = m[2].trim();
    const name = m[3].trim();

    // Sanity: type must start with an uppercase letter or known primitive
    if (!/^(?:[A-Z]|int\b|long\b|double\b|float\b|boolean\b|byte\b|char\b|short\b|void\b)/.test(typeRaw)) return null;

    return {
      name,
      type: typeRaw,
      visibility: visibilityFrom(modifiers),
      isStatic: /\bstatic\b/.test(modifiers),
      isFinal: /\bfinal\b/.test(modifiers),
      isVolatile: /\bvolatile\b/.test(modifiers),
      isTransient: /\btransient\b/.test(modifiers),
      annotations: [...annotations],
      line: lineNum
    };
  }

  /**
   * Attempts to extract a `JavaMethodDecl` starting at line index `lineIdx`.
   * Multi-line parameter lists are supported: we read forward until the
   * matching `)` is found. Returns null on no match.
   */
  private tryExtractMethod(
    lines: string[],
    lineIdx: number,
    lineNum: number,
    annotations: string[],
    knownClassNames: Set<string>
  ): JavaMethodDecl | null {
    const trimmed = lines[lineIdx].trim();

    // Collect the full signature up to the matching `)`
    const signature = this.collectSignature(lines, lineIdx);
    if (!signature) return null;

    const m = METHOD_PATTERN.exec(signature);
    if (!m) return null;

    const modifiers = m[1].trim();
    const returnTypeRaw = m[2] ? m[2].trim() : '';
    const methodName = m[3].trim();

    // Skip if name matches a known class/interface keyword or is a control flow
    if (/^(?:if|else|for|while|do|switch|catch|try|finally|new|return|throw|assert|synchronized|class|interface|enum|record)$/.test(methodName)) {
      return null;
    }

    // Extract parameter list
    const parenOpen = signature.indexOf('(');
    const parenClose = findMatchingParen(signature, parenOpen);
    if (parenClose === -1) return null;

    const rawParams = signature.slice(parenOpen + 1, parenClose);
    const parameters = parseParameterList(rawParams);

    // Determine if this is a constructor
    const isConstructor = !returnTypeRaw && knownClassNames.has(methodName);

    const isDeclaredOverride = annotations.includes('Override');

    const isAbstract = /\babstract\b/.test(modifiers);
    const isNative = /\bnative\b/.test(modifiers);
    // A concrete body exists unless the signature ends with `;` (abstract/native/interface method)
    const hasConcreteBody = !isAbstract && !isNative && !signature.trimEnd().endsWith(';');

    return {
      name: methodName,
      returnType: isConstructor ? '' : (returnTypeRaw || 'void'),
      isConstructor,
      isExported: /\bpublic\b/.test(modifiers) || /\bprotected\b/.test(modifiers),
      visibility: visibilityFrom(modifiers),
      hasConcreteBody,
      isDelegatingCall: false,
      bodyLineCount: 0,
      annotations: [...annotations],
      parameters,
      isDeclaredOverride,
      lineStart: lineNum,
      lineEnd: lineNum,
      bodyStatements: []
    };
  }

  /**
   * Collects the text from lines[startIdx] onward until the first `)` that
   * closes the `(` on or after the start of the first line, or until we
   * exceed a reasonable look-ahead (10 lines).
   */
  private collectSignature(lines: string[], startIdx: string | number): string | null {
    const idx = typeof startIdx === 'string' ? parseInt(startIdx, 10) : startIdx;
    const MAX_AHEAD = 10;
    let combined = '';
    let depth = 0;
    let found = false;

    for (let k = idx; k < lines.length && k < idx + MAX_AHEAD; k++) {
      const part = lines[k];
      combined += (k > idx ? ' ' : '') + part.trim();
      for (const ch of part) {
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) { found = true; break; }
        }
      }
      if (found) break;
    }

    return found ? combined : null;
  }
}

/**
 * Finds the index of the `)` that matches the `(` at position `openIdx`
 * in a string. Returns -1 if not found.
 */
function findMatchingParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
