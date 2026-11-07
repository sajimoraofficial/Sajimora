import { Phase4BlockerId } from '@sajimora/core';

export type TypeProvenanceKind =
  | 'USER_SOURCE'
  | 'USER_DECLARATION'
  | 'EXTERNAL_LIBRARY'
  | 'DEFAULT_LIBRARY'
  | 'SYNTHESIZED';

export interface TypeOrigin {
  readonly snapshot: 'PARENT' | 'CANDIDATE';
  readonly file: string;
  readonly span?: {
    readonly start: number;
    readonly end: number;
    readonly line: number;
    readonly column: number;
  };
  readonly provenance?: TypeProvenanceKind;
}

export interface TypeQualifiers {
  readonly nullable?: boolean;
  readonly optional?: boolean;
  readonly readonly?: boolean;
}

export interface BaseTypeIR {
  readonly schemaVersion: 'SAJIMORA_TYPE_IR_V1';
  readonly irContentHash: string;
  readonly display: string;
  readonly origin?: TypeOrigin;
  readonly qualifiers?: TypeQualifiers;
}

export interface PrimitiveTypeIR extends BaseTypeIR {
  readonly kind: 'PRIMITIVE';
  readonly primitiveKind:
    | 'string'
    | 'number'
    | 'boolean'
    | 'symbol'
    | 'bigint'
    | 'undefined'
    | 'null'
    | 'void'
    | 'never'
    | 'unknown'
    | 'any';
}

export interface LiteralTypeIR extends BaseTypeIR {
  readonly kind: 'LITERAL';
  readonly literalKind: 'string' | 'number' | 'boolean' | 'bigint';
  readonly value: string;
  readonly enumOrigin?: string;
}

export interface UnionTypeIR extends BaseTypeIR {
  readonly kind: 'UNION';
  readonly members: ReadonlyArray<TypeScriptTypeIR>;
}

export interface IntersectionTypeIR extends BaseTypeIR {
  readonly kind: 'INTERSECTION';
  readonly isCallable: boolean;
  readonly members: ReadonlyArray<TypeScriptTypeIR>;
}

export interface TypeScriptPropertyDescriptorIR {
  readonly type: TypeScriptTypeIR;
  readonly isReadonly?: boolean;
  readonly isOptional?: boolean;
  readonly visibility?: 'public' | 'protected' | 'private';
  readonly originSymbolId?: string;
  readonly hasGetter?: boolean;
  readonly hasSetter?: boolean;
}

export interface TypeScriptParameterIR {
  readonly name: string;
  readonly type: TypeScriptTypeIR;
  readonly isRequired: boolean;
  readonly isRest: boolean;
  readonly isOptional: boolean;
  readonly isFreshLiteral?: boolean;
}

export interface TypeScriptTypePredicateIR {
  readonly kind: 'IDENTIFIER' | 'ASSERTS_IDENTIFIER' | 'THIS' | 'ASSERTS_THIS';
  readonly parameterName?: string;
  readonly parameterIndex?: number;
  readonly targetType?: TypeScriptTypeIR;
}

export interface TypeScriptSignatureIR {
  readonly parameters: ReadonlyArray<TypeScriptParameterIR>;
  readonly returnType: TypeScriptTypeIR;
  readonly thisParameter?: TypeScriptParameterIR;
  readonly typePredicate?: TypeScriptTypePredicateIR;
  readonly typeParameters?: ReadonlyArray<TypeScriptTypeParameterIR>;
  readonly declarationOrdinal: number;
}

export interface TypeScriptIndexSignatureIR {
  readonly keyType: 'string' | 'number';
  readonly valueType: TypeScriptTypeIR;
  readonly isReadonly?: boolean;
}

export interface ObjectTypeIR extends BaseTypeIR {
  readonly kind: 'OBJECT';
  readonly isFreshLiteral?: boolean;
  readonly properties: ReadonlyArray<[string, TypeScriptPropertyDescriptorIR]>;
  readonly callSignatures?: ReadonlyArray<TypeScriptSignatureIR>;
  readonly constructSignatures?: ReadonlyArray<TypeScriptSignatureIR>;
  readonly indexSignatures?: ReadonlyArray<TypeScriptIndexSignatureIR>;
  readonly nominalOrigins?: ReadonlyArray<string>;
  readonly typeArguments?: ReadonlyArray<TypeScriptTypeIR>;
}

export interface ArrayTypeIR extends BaseTypeIR {
  readonly kind: 'ARRAY';
  readonly elementType: TypeScriptTypeIR;
  readonly isReadonly?: boolean;
}

export type TupleElementCardinality = 'REQUIRED' | 'OPTIONAL' | 'REST';

export interface TupleElementIR {
  readonly type: TypeScriptTypeIR;
  readonly cardinality: TupleElementCardinality;
  readonly label?: string;
}

export interface TupleTypeIR extends BaseTypeIR {
  readonly kind: 'TUPLE';
  readonly elements: ReadonlyArray<TupleElementIR>;
  readonly minLength: number;
  readonly hasRest: boolean;
  readonly isReadonly?: boolean;
}

export interface CallableTypeIR extends BaseTypeIR {
  readonly kind: 'CALLABLE';
  readonly signatures: ReadonlyArray<TypeScriptSignatureIR>;
}

export interface TypeScriptTypeParameterIR extends BaseTypeIR {
  readonly kind: 'TYPE_PARAMETER';
  readonly name: string;
  readonly binderScopeId: string;
  readonly binderIndex: number;
  readonly variance?: 'COVARIANT' | 'CONTRAVARIANT' | 'INVARIANT' | 'INDEPENDENT';
  readonly constraint?: TypeScriptTypeIR;
  readonly defaultType?: TypeScriptTypeIR;
}

export interface TypeReferenceIR extends BaseTypeIR {
  readonly kind: 'TYPE_REFERENCE';
  readonly targetSymbolPath: string;
  readonly targetDefinitionHash: string;
  readonly typeArguments?: ReadonlyArray<TypeScriptTypeIR>;
}

export interface ConditionalTypeIR extends BaseTypeIR {
  readonly kind: 'CONDITIONAL';
  readonly checkType: TypeScriptTypeIR;
  readonly extendsType: TypeScriptTypeIR;
  readonly trueType: TypeScriptTypeIR;
  readonly falseType: TypeScriptTypeIR;
  readonly isDistributive?: boolean;
}

export interface MappedTypeIR extends BaseTypeIR {
  readonly kind: 'MAPPED';
  readonly typeParameter: string;
  readonly constraintType: TypeScriptTypeIR;
  readonly templateType: TypeScriptTypeIR;
  readonly readonlyModifier?: '+' | '-' | boolean;
  readonly optionalModifier?: '+' | '-' | boolean;
}

export interface IndexedAccessTypeIR extends BaseTypeIR {
  readonly kind: 'INDEXED_ACCESS';
  readonly objectType: TypeScriptTypeIR;
  readonly indexType: TypeScriptTypeIR;
}

export interface TemplateLiteralTypeIR extends BaseTypeIR {
  readonly kind: 'TEMPLATE_LITERAL';
  readonly texts: ReadonlyArray<string>;
  readonly types: ReadonlyArray<TypeScriptTypeIR>;
}

export interface RecursionBackreferenceIR extends BaseTypeIR {
  readonly kind: 'RECURSION_BACKREFERENCE';
  readonly scopeBindingId: string;
  readonly ancestorDepth: number;
  readonly instantiatedTypeArgumentHashes: ReadonlyArray<string>;
}

export interface UnsupportedTypeIR extends BaseTypeIR {
  readonly kind: 'UNSUPPORTED';
  readonly blockerId: Phase4BlockerId;
  readonly rawSyntaxSnippet?: string;
}

export type TypeScriptTypeIR =
  | PrimitiveTypeIR
  | LiteralTypeIR
  | UnionTypeIR
  | IntersectionTypeIR
  | ObjectTypeIR
  | ArrayTypeIR
  | TupleTypeIR
  | CallableTypeIR
  | TypeScriptTypeParameterIR
  | TypeReferenceIR
  | ConditionalTypeIR
  | MappedTypeIR
  | IndexedAccessTypeIR
  | TemplateLiteralTypeIR
  | RecursionBackreferenceIR
  | UnsupportedTypeIR;

export function containsAny(typeIR: TypeScriptTypeIR): boolean {
  if (typeIR.kind === 'PRIMITIVE' && typeIR.primitiveKind === 'any') {
    return true;
  }
  if (typeIR.kind === 'UNION' || typeIR.kind === 'INTERSECTION') {
    return typeIR.members.some(containsAny);
  }
  if (typeIR.kind === 'OBJECT') {
    for (const [, prop] of typeIR.properties) {
      if (containsAny(prop.type)) return true;
    }
    for (const sig of typeIR.callSignatures ?? []) {
      if (containsAny(sig.returnType)) return true;
      for (const param of sig.parameters) {
        if (containsAny(param.type)) return true;
      }
    }
    for (const sig of typeIR.constructSignatures ?? []) {
      if (containsAny(sig.returnType)) return true;
      for (const param of sig.parameters) {
        if (containsAny(param.type)) return true;
      }
    }
    for (const idx of typeIR.indexSignatures ?? []) {
      if (containsAny(idx.valueType)) return true;
    }
    return false;
  }
  if (typeIR.kind === 'ARRAY') {
    return containsAny(typeIR.elementType);
  }
  if (typeIR.kind === 'TUPLE') {
    return typeIR.elements.some(e => containsAny(e.type));
  }
  if (typeIR.kind === 'CALLABLE') {
    for (const sig of typeIR.signatures) {
      if (containsAny(sig.returnType)) return true;
      for (const param of sig.parameters) {
        if (containsAny(param.type)) return true;
      }
    }
    return false;
  }
  if (typeIR.kind === 'TYPE_REFERENCE') {
    return (typeIR.typeArguments ?? []).some(containsAny);
  }
  if (typeIR.kind === 'TYPE_PARAMETER') {
    return (
      (typeIR.constraint ? containsAny(typeIR.constraint) : false) ||
      (typeIR.defaultType ? containsAny(typeIR.defaultType) : false)
    );
  }
  return false;
}

export function containsUnsupported(typeIR: TypeScriptTypeIR): boolean {
  if (typeIR.kind === 'UNSUPPORTED') {
    return true;
  }
  if (typeIR.kind === 'UNION' || typeIR.kind === 'INTERSECTION') {
    return typeIR.members.some(containsUnsupported);
  }
  if (typeIR.kind === 'OBJECT') {
    for (const [, prop] of typeIR.properties) {
      if (containsUnsupported(prop.type)) return true;
    }
    for (const sig of typeIR.callSignatures ?? []) {
      if (containsUnsupported(sig.returnType)) return true;
      for (const param of sig.parameters) {
        if (containsUnsupported(param.type)) return true;
      }
    }
    for (const sig of typeIR.constructSignatures ?? []) {
      if (containsUnsupported(sig.returnType)) return true;
      for (const param of sig.parameters) {
        if (containsUnsupported(param.type)) return true;
      }
    }
    for (const idx of typeIR.indexSignatures ?? []) {
      if (containsUnsupported(idx.valueType)) return true;
    }
    return false;
  }
  if (typeIR.kind === 'ARRAY') {
    return containsUnsupported(typeIR.elementType);
  }
  if (typeIR.kind === 'TUPLE') {
    return typeIR.elements.some(e => containsUnsupported(e.type));
  }
  if (typeIR.kind === 'CALLABLE') {
    for (const sig of typeIR.signatures) {
      if (containsUnsupported(sig.returnType)) return true;
      for (const param of sig.parameters) {
        if (containsUnsupported(param.type)) return true;
      }
    }
    return false;
  }
  if (typeIR.kind === 'TYPE_REFERENCE') {
    return (typeIR.typeArguments ?? []).some(containsUnsupported);
  }
  if (typeIR.kind === 'TYPE_PARAMETER') {
    return (
      (typeIR.constraint ? containsUnsupported(typeIR.constraint) : false) ||
      (typeIR.defaultType ? containsUnsupported(typeIR.defaultType) : false)
    );
  }
  return false;
}

export function isExplicitAmbientProvenance(origin?: TypeOrigin): boolean {
  if (!origin || !origin.provenance) return false;
  return origin.provenance === 'DEFAULT_LIBRARY' || origin.provenance === 'EXTERNAL_LIBRARY';
}

export function containsUserAuthoredAny(typeIR: TypeScriptTypeIR, visited = new Set<string>()): boolean {
  if (!typeIR) return false;
  if (typeIR.kind === 'PRIMITIVE' && typeIR.primitiveKind === 'any') {
    return !isExplicitAmbientProvenance(typeIR.origin);
  }
  if (typeIR.irContentHash) {
    if (visited.has(typeIR.irContentHash)) return false;
    visited.add(typeIR.irContentHash);
  }
  if (typeIR.kind === 'UNION' || typeIR.kind === 'INTERSECTION') {
    return typeIR.members.some(m => containsUserAuthoredAny(m, visited));
  }
  if (typeIR.kind === 'OBJECT') {
    for (const [, prop] of typeIR.properties) {
      if (containsUserAuthoredAny(prop.type, visited)) return true;
    }
    for (const sig of typeIR.callSignatures ?? []) {
      if (containsUserAuthoredAny(sig.returnType, visited)) return true;
      for (const param of sig.parameters) {
        if (containsUserAuthoredAny(param.type, visited)) return true;
      }
    }
    for (const sig of typeIR.constructSignatures ?? []) {
      if (containsUserAuthoredAny(sig.returnType, visited)) return true;
      for (const param of sig.parameters) {
        if (containsUserAuthoredAny(param.type, visited)) return true;
      }
    }
    for (const idx of typeIR.indexSignatures ?? []) {
      if (containsUserAuthoredAny(idx.valueType, visited)) return true;
    }
    return false;
  }
  if (typeIR.kind === 'ARRAY') {
    return containsUserAuthoredAny(typeIR.elementType, visited);
  }
  if (typeIR.kind === 'TUPLE') {
    return typeIR.elements.some(e => containsUserAuthoredAny(e.type, visited));
  }
  if (typeIR.kind === 'CALLABLE') {
    for (const sig of typeIR.signatures) {
      if (containsUserAuthoredAny(sig.returnType, visited)) return true;
      for (const param of sig.parameters) {
        if (containsUserAuthoredAny(param.type, visited)) return true;
      }
    }
    return false;
  }
  if (typeIR.kind === 'TYPE_REFERENCE') {
    return (typeIR.typeArguments ?? []).some(a => containsUserAuthoredAny(a, visited));
  }
  return false;
}

export function isDangerousGenericArgument(arg: TypeScriptTypeIR): boolean {
  if (!arg) return false;
  if (arg.kind === 'PRIMITIVE' && arg.primitiveKind === 'any') {
    return true;
  }
  if (containsUserAuthoredAny(arg)) {
    return true;
  }
  if (containsDirectObservableAny(arg)) {
    return true;
  }
  return false;
}

export function containsGenericArgumentAny(typeIR: TypeScriptTypeIR, visited = new Set<string>()): boolean {
  if (!typeIR) return false;
  if (typeIR.irContentHash) {
    if (visited.has(typeIR.irContentHash)) return false;
    visited.add(typeIR.irContentHash);
  }
  if (typeIR.kind === 'TYPE_REFERENCE') {
    if ((typeIR.typeArguments ?? []).some(a => isDangerousGenericArgument(a))) return true;
  }
  if (typeIR.kind === 'OBJECT' && (typeIR as ObjectTypeIR).typeArguments) {
    if (((typeIR as ObjectTypeIR).typeArguments ?? []).some(a => isDangerousGenericArgument(a))) return true;
  }
  if (typeIR.kind === 'UNION' || typeIR.kind === 'INTERSECTION') {
    return typeIR.members.some(m => containsGenericArgumentAny(m, visited));
  }
  if (typeIR.kind === 'ARRAY') {
    return containsGenericArgumentAny(typeIR.elementType, visited);
  }
  if (typeIR.kind === 'TUPLE') {
    return typeIR.elements.some(e => containsGenericArgumentAny(e.type, visited));
  }
  if (typeIR.kind === 'CALLABLE') {
    for (const sig of typeIR.signatures) {
      if (containsGenericArgumentAny(sig.returnType, visited)) return true;
      for (const p of sig.parameters) {
        if (containsGenericArgumentAny(p.type, visited)) return true;
      }
    }
    return false;
  }
  if (typeIR.kind === 'OBJECT') {
    for (const [, p] of typeIR.properties) {
      if (containsGenericArgumentAny(p.type, visited)) return true;
    }
    for (const sig of typeIR.callSignatures ?? []) {
      if (containsGenericArgumentAny(sig.returnType, visited)) return true;
      for (const p of sig.parameters) {
        if (containsGenericArgumentAny(p.type, visited)) return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Evaluates whether a TypeIR contains dangerous or observable any occurrences.
 * Enforces strict polarity and obligation safety:
 * - Direct covariant outputs (properties, method returns, index signatures) yielding any are observable holes -> true.
 * - Direct contravariant inputs (required primary parameters) of type any are input holes -> true.
 * - Auxiliary ambient optional/rest parameters with explicit ambient provenance -> false.
 * - Higher-order callback parameters: permitted only if callback return type is non-any, callback parameters
 *   have explicit ambient provenance, and no generic propagation/type parameters exist in the callback signature.
 */
export function containsDirectObservableAny(typeIR: TypeScriptTypeIR, visited = new Set<string>()): boolean {
  if (!typeIR) return false;

  if (typeIR.kind === 'PRIMITIVE' && typeIR.primitiveKind === 'any') {
    return true;
  }

  if (typeIR.irContentHash) {
    if (visited.has(typeIR.irContentHash)) return false;
    visited.add(typeIR.irContentHash);
  }

  if (typeIR.kind === 'UNION' || typeIR.kind === 'INTERSECTION') {
    return typeIR.members.some(m => containsDirectObservableAny(m, visited));
  }

  if (typeIR.kind === 'ARRAY') {
    if (typeIR.elementType.kind === 'PRIMITIVE' && typeIR.elementType.primitiveKind === 'any') {
      return true;
    }
    return containsDirectObservableAny(typeIR.elementType, visited);
  }

  if (typeIR.kind === 'TUPLE') {
    return typeIR.elements.some(e =>
      (e.type.kind === 'PRIMITIVE' && e.type.primitiveKind === 'any') || containsDirectObservableAny(e.type, visited)
    );
  }

  const checkSignature = (sig: TypeScriptSignatureIR): boolean => {
    // 1. Method return type (covariant output hole)
    if (sig.returnType.kind === 'PRIMITIVE' && sig.returnType.primitiveKind === 'any') {
      return true;
    }
    if (sig.returnType.kind === 'ARRAY' && sig.returnType.elementType.kind === 'PRIMITIVE' && sig.returnType.elementType.primitiveKind === 'any') {
      return true;
    }
    if (containsDirectObservableAny(sig.returnType, visited)) {
      return true;
    }

    // 2. Parameters
    for (let i = 0; i < sig.parameters.length; i++) {
      const param = sig.parameters[i];

      // Direct primitive any parameter
      if (param.type.kind === 'PRIMITIVE' && param.type.primitiveKind === 'any') {
        if (param.isRequired && !param.isOptional && !param.isRest) {
          // Primary required parameter any (Hostile Case 10)
          return true;
        }
        // Auxiliary optional or rest parameter
        if (!isExplicitAmbientProvenance(param.type.origin)) {
          return true;
        }
        continue;
      }

      // Direct array of any parameter
      if (param.type.kind === 'ARRAY' && param.type.elementType.kind === 'PRIMITIVE' && param.type.elementType.primitiveKind === 'any') {
        if (param.isRequired && !param.isOptional && !param.isRest) {
          return true;
        }
        const isElemAmbient = isExplicitAmbientProvenance(param.type.elementType.origin);
        const isContainerAmbient = isExplicitAmbientProvenance(param.type.origin);
        if (!isElemAmbient && !isContainerAmbient) {
          return true;
        }
        continue;
      }

      // Higher-Order Callback parameter
      if (param.type.kind === 'CALLABLE') {
        for (const cbSig of param.type.signatures) {
          // Callback return type must not be any
          if (cbSig.returnType.kind === 'PRIMITIVE' && cbSig.returnType.primitiveKind === 'any') {
            return true;
          }
          if (containsDirectObservableAny(cbSig.returnType, visited)) {
            return true;
          }
          // Callback parameters
          for (const cbParam of cbSig.parameters) {
            if (cbParam.type.kind === 'PRIMITIVE' && cbParam.type.primitiveKind === 'any') {
              if (!isExplicitAmbientProvenance(cbParam.type.origin)) {
                return true;
              }
              if (cbSig.typeParameters && cbSig.typeParameters.length > 0) {
                return true;
              }
              continue;
            }
            if (cbParam.type.kind === 'ARRAY' && cbParam.type.elementType.kind === 'PRIMITIVE' && cbParam.type.elementType.primitiveKind === 'any') {
              const isElemAmbient = isExplicitAmbientProvenance(cbParam.type.elementType.origin);
              const isContainerAmbient = isExplicitAmbientProvenance(cbParam.type.origin);
              if (!isElemAmbient && !isContainerAmbient) {
                return true;
              }
              if (cbSig.typeParameters && cbSig.typeParameters.length > 0) {
                return true;
              }
              continue;
            }
            if (containsDirectObservableAny(cbParam.type, visited)) {
              return true;
            }
          }
        }
        continue;
      }

      // General parameter type recursion
      if (containsDirectObservableAny(param.type, visited)) {
        return true;
      }
    }

    return false;
  };

  if (typeIR.kind === 'OBJECT') {
    for (const [, prop] of typeIR.properties) {
      if (prop.type.kind === 'CALLABLE') {
        for (const sig of prop.type.signatures) {
          if (checkSignature(sig)) return true;
        }
        continue;
      }
      if (prop.type.kind === 'PRIMITIVE' && prop.type.primitiveKind === 'any') {
        return true;
      }
      if (prop.type.kind === 'ARRAY' && prop.type.elementType.kind === 'PRIMITIVE' && prop.type.elementType.primitiveKind === 'any') {
        return true;
      }
      if (containsDirectObservableAny(prop.type, visited)) {
        return true;
      }
    }

    for (const sig of typeIR.callSignatures ?? []) {
      if (checkSignature(sig)) return true;
    }
    for (const sig of typeIR.constructSignatures ?? []) {
      if (checkSignature(sig)) return true;
    }
    for (const idx of typeIR.indexSignatures ?? []) {
      if (idx.valueType.kind === 'PRIMITIVE' && idx.valueType.primitiveKind === 'any') {
        return true;
      }
      if (containsDirectObservableAny(idx.valueType, visited)) {
        return true;
      }
    }
    return false;
  }

  if (typeIR.kind === 'CALLABLE') {
    for (const sig of typeIR.signatures) {
      if (checkSignature(sig)) return true;
    }
    return false;
  }

  return false;
}

export function hasSemanticAnyDependency(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
  // If neither type contains any anywhere in its graph, there is no any dependency.
  if (!containsAny(source) && !containsAny(target)) {
    return false;
  }

  // Mandatory Correction 2: Identical irContentHash is strictly necessary, but NEVER sufficient alone.
  if (source.irContentHash !== target.irContentHash) {
    return true;
  }

  // 1. Root level any is directly in relational position (e.g. any <= any)
  if ((source.kind === 'PRIMITIVE' && source.primitiveKind === 'any') ||
      (target.kind === 'PRIMITIVE' && target.primitiveKind === 'any')) {
    return true;
  }

  // 2. User-authored or unverified provenance any in either snapshot
  if (containsUserAuthoredAny(source) || containsUserAuthoredAny(target)) {
    return true;
  }

  // 3. User-supplied generic argument any (Set<any>, Component<any>, etc.)
  if (containsGenericArgumentAny(source) || containsGenericArgumentAny(target)) {
    return true;
  }

  // 4. Observable output holes, primary input holes, or unsafe higher-order propagation
  if (containsDirectObservableAny(source) || containsDirectObservableAny(target)) {
    return true;
  }

  // All 4 proofs established:
  // P_canonical_equality && P_provenance && P_polarity && P_observable_safety
  return false;
}
