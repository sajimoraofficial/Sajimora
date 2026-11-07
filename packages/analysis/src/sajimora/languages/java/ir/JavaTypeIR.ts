/**
 * @file JavaTypeIR.ts
 * Java-specific intermediate representation and AST nodes for Sajimora Phase J-3.
 */

import * as crypto from 'node:crypto';
import {
  canonicalJson,
  JAVA_TYPE_IR_SCHEMA_VERSION,
  type JavaTypeIR,
  type JavaPrimitiveTypeIR,
  type JavaPrimitiveKind,
  type JavaVoidTypeIR,
  type JavaReferenceTypeIR,
  type JavaWildcardTypeIR,
  type JavaArrayTypeIR,
  type JavaTypeParameterIR,
  type JavaIntersectionTypeIR,
  type UnsupportedJavaTypeIR,
  isJavaUnsupported,
  containsJavaUnsupported,
  containsJavaTypeParameter
} from '@sajimora/core';

export {
  JAVA_TYPE_IR_SCHEMA_VERSION,
  type JavaTypeIR,
  type JavaPrimitiveTypeIR,
  type JavaPrimitiveKind,
  type JavaVoidTypeIR,
  type JavaReferenceTypeIR,
  type JavaWildcardTypeIR,
  type JavaArrayTypeIR,
  type JavaTypeParameterIR,
  type JavaIntersectionTypeIR,
  type UnsupportedJavaTypeIR,
  isJavaUnsupported,
  containsJavaUnsupported,
  containsJavaTypeParameter
};

export interface JavaParameterIR {
  readonly name: string;
  readonly type: JavaTypeIR;
  readonly isVararg: boolean;
  readonly isFinal: boolean;
  readonly annotations: ReadonlyArray<string>;
}

export interface JavaMethodSignatureIR {
  readonly name: string;
  readonly returnType: JavaTypeIR;
  readonly parameters: ReadonlyArray<JavaParameterIR>;
  readonly typeParameters: ReadonlyArray<JavaTypeParameterIR>;
  readonly visibility: 'public' | 'protected' | 'package-private' | 'private';
  readonly isStatic: boolean;
  readonly isFinal: boolean;
  readonly isAbstract: boolean;
  readonly isConstructor: boolean;
  readonly isDeclaredOverride: boolean;
  readonly annotations: ReadonlyArray<string>;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly declarationOrdinal: number;
  readonly irContentHash: string;
  readonly callSites?: ReadonlyArray<JavaCallSiteIR>;
}

export interface JavaFieldIR {
  readonly name: string;
  readonly type: JavaTypeIR;
  readonly visibility: 'public' | 'protected' | 'package-private' | 'private';
  readonly isStatic: boolean;
  readonly isFinal: boolean;
  readonly isVolatile: boolean;
  readonly isTransient: boolean;
  readonly isEnumConstant?: boolean;
  readonly constantValue?: string | number | boolean;
  readonly annotations: ReadonlyArray<string>;
  readonly line: number;
  readonly irContentHash: string;
}

export interface JavaClassDeclIR {
  readonly name: string;
  readonly fqcn: string;
  readonly simpleName: string;
  readonly binaryName: string;
  readonly packageName: string;
  readonly kind: 'class' | 'interface' | 'enum' | 'record';
  readonly extendsName?: string;
  readonly implementsNames: ReadonlyArray<string>;
  readonly fields: ReadonlyArray<JavaFieldIR>;
  readonly methods: ReadonlyArray<JavaMethodSignatureIR>;
  readonly annotations: ReadonlyArray<string>;
  readonly isExported: boolean;
  readonly isAbstract?: boolean;
  readonly isFinal?: boolean;
  readonly isSealed?: boolean;
  readonly permitsNames?: ReadonlyArray<string>;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly filePath: string;
  readonly callSites?: ReadonlyArray<JavaCallSiteIR>;
}

export interface JavaImportIR {
  readonly importedName: string;
  readonly moduleSpecifier: string;
  readonly isStatic: boolean;
  readonly isWildcard: boolean;
  readonly line: number;
}

/**
 * Method-body call site, constructor invocation, method reference, or field access
 * extracted during Phase J-5 for consumer graph completeness.
 */
export interface JavaCallSiteIR {
  /** Enclosing class FQCN */
  readonly enclosingClassFqcn: string;
  /** Enclosing method name or initializer (e.g. "handle", "<init>", "<clinit>") */
  readonly enclosingMethodName: string;
  /** Name of the invoked method, constructor, or accessed field */
  readonly calleeName: string;
  /** Receiver expression text if present (e.g. "service", "OrderService", "this", "super") */
  readonly receiverText?: string;
  /** Number of arguments supplied */
  readonly argumentCount: number;
  /** Source line (1-indexed) */
  readonly line: number;
  /** Source column (1-indexed) */
  readonly column?: number;
  /** Call-site kind */
  readonly callKind: 'METHOD_CALL' | 'CONSTRUCTOR_CALL' | 'METHOD_REFERENCE' | 'CONSTRUCTOR_REFERENCE' | 'FIELD_ACCESS';
  /**
   * Evidence tier per J-5 spec:
   * - 'STATIC_AST': receiver is a known type identifier, class literal, static import target, 'this', 'super', or constructor
   * - 'HEURISTIC': receiver is a variable or complex expression whose runtime receiver type is inferred
   */
  readonly evidenceKind: 'STATIC_AST' | 'HEURISTIC';
  /** Target FQCN if resolved statically via imports, package, or static access */
  readonly resolvedTargetFqcn?: string;
  /** Raw text of the invocation/expression */
  readonly rawText?: string;
}

export type JavaASTNode =
  | {
      readonly kind: 'DECLARATION';
      readonly declarationKind: 'CLASS' | 'INTERFACE' | 'ENUM' | 'RECORD';
      readonly decl: JavaClassDeclIR;
      readonly fqcn: string;
      readonly file: string;
    }
  | {
      readonly kind: 'DECLARATION';
      readonly declarationKind: 'METHOD' | 'CONSTRUCTOR';
      readonly method: JavaMethodSignatureIR;
      readonly enclosingClassFqcn: string;
      readonly fqcn: string;
      readonly file: string;
    }
  | {
      readonly kind: 'DECLARATION';
      readonly declarationKind: 'FIELD';
      readonly field: JavaFieldIR;
      readonly enclosingClassFqcn: string;
      readonly fqcn: string;
      readonly file: string;
    }
  | {
      readonly kind: 'USAGE';
      readonly usageRole: 'CALL_SITE' | 'TYPE_ANNOTATION' | 'INHERITANCE' | 'VALUE_ASSIGNMENT' | 'METHOD_REFERENCE' | 'CONSTRUCTOR_REFERENCE';
      readonly expectedType: JavaTypeIR;
      readonly isDiscardedReturn?: boolean;
      readonly targetFqcn?: string;
      readonly file: string;
      readonly line: number;
    }
  | {
      readonly kind: 'CALL_SITE';
      readonly callSite: JavaCallSiteIR;
      readonly file: string;
      readonly line: number;
    }
  | {
      readonly kind: 'TYPE';
      readonly typeIR: JavaTypeIR;
    };

export function computeJavaMethodHash(method: Omit<JavaMethodSignatureIR, 'irContentHash'>): string {
  const content = {
    name: method.name,
    returnTypeHash: method.returnType.irContentHash,
    parameters: method.parameters.map(p => ({
      name: p.name,
      typeHash: p.type.irContentHash,
      isVararg: p.isVararg
    })),
    visibility: method.visibility,
    isStatic: method.isStatic,
    isFinal: method.isFinal,
    isAbstract: method.isAbstract,
    isConstructor: method.isConstructor,
    annotations: [...method.annotations].sort(),
    declarationOrdinal: method.declarationOrdinal
  };
  return crypto
    .createHash('sha256')
    .update('SAJIMORA_JAVA_METHOD_V1\0' + canonicalJson(content), 'utf8')
    .digest('hex');
}

export function computeJavaFieldHash(field: Omit<JavaFieldIR, 'irContentHash'>): string {
  const content = {
    name: field.name,
    typeHash: field.type.irContentHash,
    visibility: field.visibility,
    isStatic: field.isStatic,
    isFinal: field.isFinal,
    ...(field.isEnumConstant === undefined ? {} : {isEnumConstant: field.isEnumConstant}),
    constantValue: field.constantValue !== undefined ? String(field.constantValue) : null,
    annotations: [...field.annotations].sort()
  };
  return crypto
    .createHash('sha256')
    .update('SAJIMORA_JAVA_FIELD_V1\0' + canonicalJson(content), 'utf8')
    .digest('hex');
}
