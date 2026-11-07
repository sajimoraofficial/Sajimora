/**
 * @file JavaCanonicalIdentity.ts
 * Canonical API Member Identity and Consumer Identity model for Java.
 * Enforces Phase 1 requirements:
 * 1. Module / artifact
 * 2. Package
 * 3. Declaring class/interface/record/enum/annotation
 * 4. Member kind (CLASS, METHOD, CONSTRUCTOR, FIELD, ENUM_CONSTANT, RECORD_COMPONENT)
 * 5. Member name
 * 6. JVM descriptor (JLS §13 / JVMS §4.3)
 * 7. Generic signature where applicable
 * 8. Visibility (public, protected, package-private, private)
 * 9. Static / instance state
 * 10. Inheritance / interface relationship
 */

import { JavaTypeIR } from '../ir/JavaTypeIR';
import { JavaClassDeclIR, JavaMethodSignatureIR, JavaFieldIR, JavaParameterIR } from '../ir/JavaTypeIR';

export type JavaMemberKind =
  | 'CLASS'
  | 'INTERFACE'
  | 'RECORD'
  | 'ENUM'
  | 'ANNOTATION'
  | 'METHOD'
  | 'CONSTRUCTOR'
  | 'FIELD'
  | 'ENUM_CONSTANT'
  | 'RECORD_COMPONENT';

export type JavaVisibility = 'public' | 'protected' | 'package-private' | 'private';

export interface CanonicalApiMemberIdentity {
  /** Unique canonical member identifier: e.g. "com.google.common.base.Preconditions#checkNotNull(Ljava/lang/Object;)Ljava/lang/Object;" */
  readonly canonicalId: string;
  readonly moduleOrArtifact?: string;
  readonly packageName: string;
  readonly declaringClassFqcn: string;
  readonly declaringClassKind: 'class' | 'interface' | 'record' | 'enum' | 'annotation';
  readonly memberKind: JavaMemberKind;
  readonly memberName: string;
  /** JVMS §4.3 JVM Descriptor, e.g. "(Ljava/lang/String;I)V" or "Ljava/lang/String;" */
  readonly jvmDescriptor: string;
  readonly genericSignature?: string;
  readonly visibility: JavaVisibility;
  readonly isStatic: boolean;
  readonly isFinal: boolean;
  readonly isAbstract: boolean;
  readonly superclass?: string;
  readonly interfaces: readonly string[];
  readonly permits?: readonly string[];
  readonly changeKind?: string;
}

export interface CanonicalConsumerIdentity {
  readonly consumerId?: string;
  readonly consumerFqcn: string;
  readonly consumerFile: string;
  readonly enclosingMethodOrMember?: string;
  readonly location: string;
  readonly line: number;
  readonly column?: number;
  readonly bindingKind: string;
  readonly referencedMember: CanonicalApiMemberIdentity;
}

/**
 * Converts a JavaTypeIR intermediate representation into a JVMS §4.3 JVM descriptor string.
 */
export function javaTypeToJvmDescriptor(type: JavaTypeIR): string {
  switch (type.kind) {
    case 'JAVA_PRIMITIVE':
      switch (type.primitiveKind) {
        case 'boolean': return 'Z';
        case 'byte': return 'B';
        case 'char': return 'C';
        case 'short': return 'S';
        case 'int': return 'I';
        case 'long': return 'J';
        case 'float': return 'F';
        case 'double': return 'D';
        default: return 'Ljava/lang/Object;';
      }
    case 'JAVA_VOID':
      return 'V';
    case 'JAVA_REFERENCE': {
      const qname = type.qualifiedName || type.display || 'java.lang.Object';
      // Normalize common names
      let normalized = qname;
      if (!normalized.includes('.')) {
        if (normalized === 'String') normalized = 'java.lang.String';
        else if (normalized === 'Object') normalized = 'java.lang.Object';
        else if (normalized === 'CharSequence') normalized = 'java.lang.CharSequence';
        else if (normalized === 'Integer') normalized = 'java.lang.Integer';
        else if (normalized === 'Long') normalized = 'java.lang.Long';
        else if (normalized === 'Boolean') normalized = 'java.lang.Boolean';
      }
      return `L${normalized.replace(/\./g, '/')};`;
    }
    case 'JAVA_ARRAY': {
      const dims = '['.repeat(type.dimensions || 1);
      return `${dims}${javaTypeToJvmDescriptor(type.elementType)}`;
    }
    case 'JAVA_TYPE_PARAMETER': {
      if (type.upperBounds && type.upperBounds.length > 0) {
        return javaTypeToJvmDescriptor(type.upperBounds[0]);
      }
      return 'Ljava/lang/Object;';
    }
    case 'JAVA_WILDCARD': {
      if (type.bound === 'UPPER' && type.boundType) {
        return javaTypeToJvmDescriptor(type.boundType);
      }
      return 'Ljava/lang/Object;';
    }
    default:
      return 'Ljava/lang/Object;';
  }
}

/**
 * Computes JVMS §4.3.3 method descriptor: (p1;p2)ret
 */
export function computeMethodJvmDescriptor(
  parameters: ReadonlyArray<JavaParameterIR>,
  returnType: JavaTypeIR,
  isConstructor?: boolean
): string {
  const paramDescriptors = parameters.map(p => javaTypeToJvmDescriptor(p.type)).join('');
  const retDescriptor = isConstructor ? 'V' : javaTypeToJvmDescriptor(returnType);
  return `(${paramDescriptors})${retDescriptor}`;
}

/**
 * Builds a CanonicalApiMemberIdentity for a class declaration.
 */
export function buildClassCanonicalIdentity(
  cls: JavaClassDeclIR,
  moduleOrArtifact?: string,
  changeKind?: string
): CanonicalApiMemberIdentity {
  const kindUpper = cls.kind.toUpperCase() as JavaMemberKind;
  return {
    canonicalId: cls.fqcn,
    moduleOrArtifact,
    packageName: cls.packageName,
    declaringClassFqcn: cls.fqcn,
    declaringClassKind: cls.kind as any,
    memberKind: kindUpper,
    memberName: cls.simpleName,
    jvmDescriptor: `L${cls.fqcn.replace(/\./g, '/')};`,
    visibility: cls.isExported ? 'public' : 'package-private',
    isStatic: false,
    isFinal: Boolean(cls.isFinal),
    isAbstract: Boolean(cls.isAbstract),
    superclass: cls.extendsName,
    interfaces: [...cls.implementsNames],
    permits: (cls as any).permitsNames ? [...(cls as any).permitsNames] : undefined,
    changeKind
  };
}

/**
 * Builds a CanonicalApiMemberIdentity for a method declaration.
 */
export function buildMethodCanonicalIdentity(
  cls: JavaClassDeclIR,
  m: JavaMethodSignatureIR,
  moduleOrArtifact?: string,
  changeKind?: string
): CanonicalApiMemberIdentity {
  const descriptor = computeMethodJvmDescriptor(m.parameters, m.returnType, m.isConstructor);
  const memberKind: JavaMemberKind = m.isConstructor ? 'CONSTRUCTOR' : 'METHOD';
  const name = m.isConstructor ? '<init>' : m.name;
  return {
    canonicalId: `${cls.fqcn}#${name}${descriptor}`,
    moduleOrArtifact,
    packageName: cls.packageName,
    declaringClassFqcn: cls.fqcn,
    declaringClassKind: cls.kind as any,
    memberKind,
    memberName: name,
    jvmDescriptor: descriptor,
    visibility: m.visibility,
    isStatic: m.isStatic,
    isFinal: m.isFinal,
    isAbstract: m.isAbstract,
    superclass: cls.extendsName,
    interfaces: [...cls.implementsNames],
    changeKind
  };
}

/**
 * Builds a CanonicalApiMemberIdentity for a field declaration.
 */
export function buildFieldCanonicalIdentity(
  cls: JavaClassDeclIR,
  f: JavaFieldIR,
  moduleOrArtifact?: string,
  changeKind?: string
): CanonicalApiMemberIdentity {
  const descriptor = javaTypeToJvmDescriptor(f.type);
  return {
    canonicalId: `${cls.fqcn}#${f.name}:${descriptor}`,
    moduleOrArtifact,
    packageName: cls.packageName,
    declaringClassFqcn: cls.fqcn,
    declaringClassKind: cls.kind as any,
    memberKind: 'FIELD',
    memberName: f.name,
    jvmDescriptor: descriptor,
    visibility: f.visibility,
    isStatic: f.isStatic,
    isFinal: f.isFinal,
    isAbstract: false,
    superclass: cls.extendsName,
    interfaces: [...cls.implementsNames],
    changeKind
  };
}
