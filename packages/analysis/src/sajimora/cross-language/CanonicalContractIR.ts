/**
 * CanonicalContractIR.ts
 *
 * Language-independent canonical contract IR for cross-language API compatibility analysis.
 * Both Java Spring endpoints and TypeScript HTTP clients/contracts normalize into this IR
 * before structural and semantic comparison.
 *
 * Preserves source provenance on every meaningful IR node.
 */

// ---------------------------------------------------------------------------
// Source Provenance
// ---------------------------------------------------------------------------

export type SourceLanguage = 'JAVA' | 'TYPESCRIPT';

export interface SourceProvenance {
  readonly callIdentity?: import('./CallIdentity').CallIdentity;
  readonly sha256?: string;
  readonly language: SourceLanguage;
  /** Repository-relative POSIX file path. */
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  /** AST node identity or symbol name (e.g. "UserDto.getDisplayName", "interface UserDto"). */
  readonly astIdentity?: string;
  /** Originating annotation or schema (e.g. "@JsonProperty('name')", "z.string()"). */
  readonly annotationOrSchema?: string;
}

// ---------------------------------------------------------------------------
// Validation Constraints (Request / Response validation metadata)
// ---------------------------------------------------------------------------

export type ValidationConstraintKind =
  | 'NOT_NULL'
  | 'NOT_BLANK'
  | 'NOT_EMPTY'
  | 'SIZE'
  | 'MIN'
  | 'MAX'
  | 'PATTERN'
  | 'EMAIL';

export interface ValidationConstraint {
  readonly kind: ValidationConstraintKind;
  readonly value?: string | number;
  readonly message?: string;
  readonly provenance?: SourceProvenance;
}

// ---------------------------------------------------------------------------
// Canonical WireType
// ---------------------------------------------------------------------------

export type WireTypeKind =
  | 'PRIMITIVE'
  | 'OBJECT'
  | 'ARRAY'
  | 'UNION'
  | 'ENUM'
  | 'NULLABLE'
  | 'OPTIONAL'
  | 'MAP'
  | 'LITERAL'
  | 'UNKNOWN'
  | 'REF';

export type PrimitiveScalar = 'string' | 'number' | 'boolean' | 'bigint' | 'void' | 'any';

export interface BaseWireType {
  readonly kind: WireTypeKind;
  readonly provenance?: SourceProvenance;
}

export interface PrimitiveWireType extends BaseWireType {
  readonly kind: 'PRIMITIVE';
  readonly scalar: PrimitiveScalar;
}

export interface WirePropertyContract {
  readonly wireName: string;
  readonly type: WireType;
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly validationConstraints: readonly ValidationConstraint[];
  readonly provenance?: SourceProvenance;
  readonly hasDefault?: boolean;
  readonly defaultValue?: unknown;
  readonly outputOptional?: boolean;
}


export interface ObjectWireType extends BaseWireType {
  readonly kind: 'OBJECT';
  readonly name?: string;
  readonly properties: readonly WirePropertyContract[];
  /** Whether the object forbids extra properties (e.g. z.object().strict()). Default false. */
  readonly strict?: boolean;
}

export interface ArrayWireType extends BaseWireType {
  readonly kind: 'ARRAY';
  readonly elementType: WireType;
  /** Positional tuple element types if known */
  readonly tupleElements?: readonly WireType[];
  /** Whether this array originated from a reactive Flux or stream. */
  readonly isStreamOrFlux?: boolean;
}

export interface UnionWireType extends BaseWireType {
  readonly kind: 'UNION';
  readonly types: readonly WireType[];
}

export interface EnumWireType extends BaseWireType {
  readonly kind: 'ENUM';
  readonly name?: string;
  readonly values: readonly (string | number)[];
}

export interface NullableWireType extends BaseWireType {
  readonly kind: 'NULLABLE';
  readonly innerType: WireType;
}

export interface OptionalWireType extends BaseWireType {
  readonly kind: 'OPTIONAL';
  readonly innerType: WireType;
}

export interface MapWireType extends BaseWireType {
  readonly kind: 'MAP';
  readonly keyType: WireType;
  readonly valueType: WireType;
}

export interface LiteralWireType extends BaseWireType {
  readonly kind: 'LITERAL';
  readonly value: string | number | boolean;
}

export interface UnknownWireType extends BaseWireType {
  readonly kind: 'UNKNOWN';
  readonly reason: string;
}

export interface RefWireType extends BaseWireType {
  readonly kind: 'REF';
  readonly ref: string;
}

export type WireType =
  | PrimitiveWireType
  | ObjectWireType
  | ArrayWireType
  | UnionWireType
  | EnumWireType
  | NullableWireType
  | OptionalWireType
  | MapWireType
  | LiteralWireType
  | UnknownWireType
  | RefWireType;

// ---------------------------------------------------------------------------
// Route & Endpoint Contract
// ---------------------------------------------------------------------------

export interface RouteSegmentContract {
  readonly text: string;
  readonly isParam: boolean;
  readonly paramIndex?: number;
  readonly paramName?: string;
  readonly regexConstraint?: string;
  readonly isWildcard?: boolean;
}

export interface NormalizedRouteContract {
  readonly rawPath: string;
  readonly segments: readonly RouteSegmentContract[];
}

export type ContractDirection = 'REQUEST' | 'RESPONSE';

export interface EndpointIdentityContract {
  readonly service: string | null;
  readonly httpMethod: string;
  readonly normalizedRoute: NormalizedRouteContract;
  readonly direction: ContractDirection;
}

export interface ParamContract {
  readonly name: string;
  readonly type: WireType;
  readonly required: boolean;
  readonly validationConstraints?: readonly ValidationConstraint[];
  readonly provenance?: SourceProvenance;
}

export interface EndpointContract {
  /** Captured mapping predicates, distinct from parameter binding requiredness. */
  readonly mappingConditions?:{readonly params:readonly string[];readonly complete:boolean};
  /** Explicit declared transport facts; absence means not captured. */
  readonly responseStatuses?:readonly number[];
  readonly mediaTypes?:readonly string[];
  readonly identity: EndpointIdentityContract;
  readonly pathParameters: readonly ParamContract[];
  readonly queryParameters: readonly ParamContract[];
  readonly headers: readonly ParamContract[];
  readonly body: WireType | null;
  readonly provenance: SourceProvenance;
}

// ---------------------------------------------------------------------------
// Factory Helpers
// ---------------------------------------------------------------------------

export function mkPrimitiveWireType(scalar: PrimitiveScalar, provenance?: SourceProvenance): PrimitiveWireType {
  return { kind: 'PRIMITIVE', scalar, provenance };
}

export function mkObjectWireType(
  properties: readonly WirePropertyContract[],
  name?: string,
  strict?: boolean,
  provenance?: SourceProvenance
): ObjectWireType {
  return { kind: 'OBJECT', name, properties, strict, provenance };
}

export function mkArrayWireType(
  elementType: WireType,
  isStreamOrFlux?: boolean,
  provenance?: SourceProvenance,
  tupleElements?: readonly WireType[]
): ArrayWireType {
  return { kind: 'ARRAY', elementType, isStreamOrFlux, provenance, ...(tupleElements && tupleElements.length > 0 ? { tupleElements } : {}) };
}

export function mkUnionWireType(types: readonly WireType[], provenance?: SourceProvenance): UnionWireType {
  return { kind: 'UNION', types, provenance };
}

export function mkEnumWireType(values: readonly (string | number)[], name?: string, provenance?: SourceProvenance): EnumWireType {
  return { kind: 'ENUM', name, values, provenance };
}

export function mkNullableWireType(innerType: WireType, provenance?: SourceProvenance): NullableWireType {
  return { kind: 'NULLABLE', innerType, provenance };
}

export function mkOptionalWireType(innerType: WireType, provenance?: SourceProvenance): OptionalWireType {
  return { kind: 'OPTIONAL', innerType, provenance };
}

export function mkLiteralWireType(value: string | number | boolean, provenance?: SourceProvenance): LiteralWireType {
  return { kind: 'LITERAL', value, provenance };
}

export function mkUnknownWireType(reason: string, provenance?: SourceProvenance): UnknownWireType {
  return { kind: 'UNKNOWN', reason, provenance };
}

export function mkRefWireType(ref: string, provenance?: SourceProvenance): RefWireType {
  return { kind: 'REF', ref, provenance };
}

