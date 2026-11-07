/**
 * @file java.ts
 * J-2: JavaTypeIR — language-specific type intermediate representation for Java.
 *
 * Design constraints:
 *  - Strictly additive; no existing types in @sajimora/core are modified.
 *  - Nominally typed (Java is not structurally typed).
 *  - Schema version is SAJIMORA_JAVA_TYPE_IR_V1, distinct from SAJIMORA_TYPE_IR_V1 (TypeScript).
 *  - irContentHash covers semantic content only (kind + kind-specific fields);
 *    display is excluded so that whitespace variations produce the same hash.
 *  - Unsupported or parse-failure forms produce UnsupportedJavaTypeIR (fail-closed).
 *  - No JVM, JavaParser, or JDT dependency — types are populated from raw source strings.
 */

// ─── Schema ───────────────────────────────────────────────────────────────────

export type JavaTypeIRSchemaVersion = 'SAJIMORA_JAVA_TYPE_IR_V1';
export const JAVA_TYPE_IR_SCHEMA_VERSION: JavaTypeIRSchemaVersion = 'SAJIMORA_JAVA_TYPE_IR_V1';

// ─── Base ─────────────────────────────────────────────────────────────────────

export interface BaseJavaTypeIR {
  /** Fixed schema version for forward-compatibility guards. */
  readonly schemaVersion: JavaTypeIRSchemaVersion;
  /**
   * SHA-256 hex digest over the canonical content of this IR node.
   * Computed over kind + kind-specific fields; excludes display and schemaVersion.
   * Recursive types hash their children by content hash, not by value.
   */
  readonly irContentHash: string;
  /**
   * Raw type string as written in source.  Preserved for display/debugging only;
   * never used in hash computation or compatibility decisions.
   */
  readonly display: string;
}

// ─── Primitive types ──────────────────────────────────────────────────────────

export type JavaPrimitiveKind =
  | 'int' | 'long' | 'double' | 'float'
  | 'boolean' | 'byte' | 'char' | 'short';

export const JAVA_PRIMITIVE_KINDS: ReadonlySet<JavaPrimitiveKind> = new Set([
  'int', 'long', 'double', 'float', 'boolean', 'byte', 'char', 'short'
]);

export interface JavaPrimitiveTypeIR extends BaseJavaTypeIR {
  readonly kind: 'JAVA_PRIMITIVE';
  readonly primitiveKind: JavaPrimitiveKind;
}

// ─── Void ─────────────────────────────────────────────────────────────────────

/** `void` return type.  Separate from primitives to avoid accidental assignability. */
export interface JavaVoidTypeIR extends BaseJavaTypeIR {
  readonly kind: 'JAVA_VOID';
}

// ─── Reference types ──────────────────────────────────────────────────────────

/**
 * Any named reference type: simple name (`String`), FQCN (`java.util.List`),
 * or a generic instantiation (`List<String>`, `Map<String, List<Order>>`).
 *
 * Type arguments are themselves full JavaTypeIR nodes; wildcards appear as
 * JavaWildcardTypeIR members of the typeArguments array.
 */
export interface JavaReferenceTypeIR extends BaseJavaTypeIR {
  readonly kind: 'JAVA_REFERENCE';
  /** Qualified name exactly as written in source (e.g. "java.util.List" or "List"). */
  readonly qualifiedName: string;
  /** The rightmost simple name segment (e.g. "List" from "java.util.List"). */
  readonly simpleName: string;
  /** True when qualifiedName contains at least one `.` separator. */
  readonly isFullyQualified: boolean;
  /**
   * Type arguments in declaration order.  Empty array means no type arguments
   * (raw type or non-generic).  May include JavaWildcardTypeIR nodes.
   */
  readonly typeArguments: ReadonlyArray<JavaTypeIR>;
}

// ─── Wildcards ────────────────────────────────────────────────────────────────

/**
 * Wildcard type argument: `?`, `? extends T`, `? super T`.
 * Only valid in type argument positions.
 */
export interface JavaWildcardTypeIR extends BaseJavaTypeIR {
  readonly kind: 'JAVA_WILDCARD';
  readonly bound: 'UNBOUNDED' | 'UPPER' | 'LOWER';
  /**
   * The type that bounds this wildcard.
   * Present for UPPER (`? extends T`) and LOWER (`? super T`).
   * Absent for UNBOUNDED (`?`).
   */
  readonly boundType?: JavaTypeIR;
}

// ─── Array types ──────────────────────────────────────────────────────────────

/**
 * Array type: `int[]`, `String[][]`, vararg `String...`.
 * elementType never itself carries array brackets — nesting is expressed
 * through the `dimensions` count.
 */
export interface JavaArrayTypeIR extends BaseJavaTypeIR {
  readonly kind: 'JAVA_ARRAY';
  /** The element type (without any array dimensions). */
  readonly elementType: JavaTypeIR;
  /** Number of array dimensions: 1 for `T[]`, 2 for `T[][]`, etc. */
  readonly dimensions: number;
  /**
   * True when this array was expressed as a vararg parameter (`T... name`).
   * Always false for field types or return types.
   */
  readonly isVararg: boolean;
}

// ─── Type parameters ──────────────────────────────────────────────────────────

/**
 * A declared type parameter: `T`, `E`, `K extends Comparable<K>`.
 *
 * In J-2, type parameters are inferred heuristically from raw source strings
 * (single uppercase letter → type parameter).  Bounds are populated only when
 * the full method/class type-parameter declaration is parsed (future J-3).
 * For J-2 usage sites (type argument positions), upperBounds is always empty.
 */
export interface JavaTypeParameterIR extends BaseJavaTypeIR {
  readonly kind: 'JAVA_TYPE_PARAMETER';
  /** The type parameter name as written (e.g. "T", "E", "K"). */
  readonly name: string;
  /**
   * Upper bounds from `extends` clauses (e.g. `T extends Comparable<T>`).
   * Empty when parsed from a use-site context without bound information.
   */
  readonly upperBounds: ReadonlyArray<JavaTypeIR>;
}

// ─── Intersection types ───────────────────────────────────────────────────────

/**
 * Intersection type, only valid in type-parameter bound context: `A & B`.
 * Example: `<T extends Serializable & Comparable<T>>`.
 *
 * Reserved for J-3+ when full type-parameter declaration parsing is added.
 * Defined here so the IR is complete and forward-compatible.
 */
export interface JavaIntersectionTypeIR extends BaseJavaTypeIR {
  readonly kind: 'JAVA_INTERSECTION';
  /** All intersected types, in declaration order. Two or more members. */
  readonly members: ReadonlyArray<JavaTypeIR>;
}

// ─── Unsupported / parse failure ──────────────────────────────────────────────

/**
 * Fail-closed IR node for any type string that cannot be classified.
 * Consumers that encounter this node MUST treat it as UNKNOWN / INCOMPLETE,
 * never as PRESERVED.
 */
export interface UnsupportedJavaTypeIR extends BaseJavaTypeIR {
  readonly kind: 'JAVA_UNSUPPORTED';
  /** Human-readable reason why the type string could not be classified. */
  readonly reason: string;
  /** The original raw input that failed parsing. */
  readonly rawInput: string;
}

// ─── Union ────────────────────────────────────────────────────────────────────

export type JavaTypeIR =
  | JavaPrimitiveTypeIR
  | JavaVoidTypeIR
  | JavaReferenceTypeIR
  | JavaWildcardTypeIR
  | JavaArrayTypeIR
  | JavaTypeParameterIR
  | JavaIntersectionTypeIR
  | UnsupportedJavaTypeIR;

// ─── Type predicates ──────────────────────────────────────────────────────────

export function isJavaUnsupported(t: JavaTypeIR): t is UnsupportedJavaTypeIR {
  return t.kind === 'JAVA_UNSUPPORTED';
}

export function containsJavaUnsupported(t: JavaTypeIR): boolean {
  if (t.kind === 'JAVA_UNSUPPORTED') return true;
  if (t.kind === 'JAVA_REFERENCE') return t.typeArguments.some(containsJavaUnsupported);
  if (t.kind === 'JAVA_ARRAY') return containsJavaUnsupported(t.elementType);
  if (t.kind === 'JAVA_WILDCARD') return t.boundType !== undefined && containsJavaUnsupported(t.boundType);
  if (t.kind === 'JAVA_TYPE_PARAMETER') return t.upperBounds.some(containsJavaUnsupported);
  if (t.kind === 'JAVA_INTERSECTION') return t.members.some(containsJavaUnsupported);
  return false;
}

/**
 * Returns true if any node in the IR tree is a JavaTypeParameterIR.
 * Used to check whether a type can be structurally compared without
 * generic instantiation context.
 */
export function containsJavaTypeParameter(t: JavaTypeIR): boolean {
  if (t.kind === 'JAVA_TYPE_PARAMETER') return true;
  if (t.kind === 'JAVA_REFERENCE') return t.typeArguments.some(containsJavaTypeParameter);
  if (t.kind === 'JAVA_ARRAY') return containsJavaTypeParameter(t.elementType);
  if (t.kind === 'JAVA_WILDCARD') return t.boundType !== undefined && containsJavaTypeParameter(t.boundType);
  if (t.kind === 'JAVA_INTERSECTION') return t.members.some(containsJavaTypeParameter);
  return false;
}
