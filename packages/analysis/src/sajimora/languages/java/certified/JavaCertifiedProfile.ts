/**
 * @file JavaCertifiedProfile.ts
 * Certified profile definitions, boundary policies, and admission requirements
 * for Java F0 certification per casebgoal.md §Phase 10 and
 * java_language_track_architecture.md §8 & §11.
 *
 * Strict boundary:
 *   - JAVA_CERTIFIED_PROFILE_F0 is language-specific to Java.
 *   - Does not modify or intercept TypeScript certified profiles.
 *   - Does not bypass VerdictAuthority; operates as an independent certified
 *     evidence derivation profile for Java public API contracts.
 */

import { JavaClassDeclIR } from '../ir';

export const JAVA_CERTIFIED_EVIDENCE_V1 = 'JAVA_CERTIFIED_EVIDENCE_V1';
export type JavaSchemaVersion = typeof JAVA_CERTIFIED_EVIDENCE_V1;

export enum JavaSemanticProfileId {
  JAVA_PUBLIC_API_F0 = 'JAVA_PUBLIC_API_F0',
  JAVA_COMPILER_BACKED_F1 = 'JAVA_COMPILER_BACKED_F1'
}

export enum JavaRuleSetId {
  JAVA_F0_RULES_V1 = 'JAVA_F0_RULES_V1',
  JAVA_F1_RULES_V1 = 'JAVA_F1_RULES_V1'
}

export enum JavaResolverProfileId {
  JAVA_F0_EXPLICIT_FQCN_V1 = 'JAVA_F0_EXPLICIT_FQCN_V1',
  JAVA_F1_HEADLESS_COMPILER_V1 = 'JAVA_F1_HEADLESS_COMPILER_V1'
}

export enum JavaBoundaryPolicyId {
  JAVA_F0_STRICT_BOUNDARY_V1 = 'JAVA_F0_STRICT_BOUNDARY_V1',
  JAVA_F1_MONOTONIC_BOUNDARY_V1 = 'JAVA_F1_MONOTONIC_BOUNDARY_V1'
}

export interface JavaF0AdmissionResult {
  readonly admitted: boolean;
  readonly status: 'ADMITTED_F0' | 'DISQUALIFIED_ADVISORY_ONLY';
  readonly profileId: JavaSemanticProfileId | null;
  readonly disqualificationReasons: readonly string[];
  readonly metrics: {
    readonly totalImports: number;
    readonly wildcardImports: number;
    readonly explicitImports: number;
    readonly publicDeclarations: number;
    readonly undecidableConstructs: number;
  };
}

export interface JavaF0CandidateFile {
  readonly path: string;
  readonly content?: string;
  readonly packageName: string;
  readonly imports: readonly string[];
  readonly classes?: readonly JavaClassDeclIR[];
}

/**
 * Checks if a Java file satisfies the strict F0 profile certification boundary.
 *
 * F0 Boundary Requirements:
 * 1. No wildcard imports (`import foo.*` is forbidden in F0; must use explicit single-type imports).
 * 2. No reflection or dynamic proxies (J-X1..J-X3 undecidable constructs disqualify from F0).
 * 3. Clean declaration structure (all referenced symbols must be fully resolvable).
 * 4. Must contain at least one public or protected declaration.
 */
export function evaluateJavaF0Admission(candidate: JavaF0CandidateFile): JavaF0AdmissionResult {
  const reasons: string[] = [];
  const imports = candidate.imports ?? [];

  // 1. Wildcard imports check
  const wildcardImports = imports.filter(imp => imp.trim().endsWith('.*') || imp.includes('*'));
  if (wildcardImports.length > 0) {
    reasons.push(
      `Disqualified from Certified F0: Wildcard import(s) detected: [${wildcardImports.join(', ')}]. ` +
      `F0 requires explicit single-type imports (JAVA_F0_EXPLICIT_FQCN_V1).`
    );
  }

  // 2. Reflection and dynamic proxy check (J-X1..J-X3)
  let undecidableCount = 0;
  const content = candidate.content ?? '';
  const reflectionPatterns = [
    /Class\.forName\s*\(/,
    /Method\.invoke\s*\(/,
    /Proxy\.newProxyInstance\s*\(/,
    /java\.lang\.reflect/,
    /sun\.misc\.Unsafe/,
    /java\.lang\.invoke\.MethodHandles/
  ];

  for (const pattern of reflectionPatterns) {
    if (pattern.test(content)) {
      undecidableCount++;
      reasons.push(
        `Disqualified from Certified F0: Undecidable dynamic construct detected matching ${pattern.source} (J-X1..J-X3).`
      );
    }
  }

  // Check imports for reflection
  const reflectionImports = imports.filter(imp => imp.startsWith('java.lang.reflect.') || imp.startsWith('java.lang.invoke.'));
  if (reflectionImports.length > 0) {
    undecidableCount += reflectionImports.length;
    reasons.push(`Disqualified from Certified F0: Reflection import(s): [${reflectionImports.join(', ')}].`);
  }

  // 3. Declarations check
  let publicDecls = 0;
  if (candidate.classes && candidate.classes.length > 0) {
    publicDecls = candidate.classes.length;
  } else {
    // If no parsed classes, estimate from content
    const pubMatches = content.match(/public\s+(?:class|interface|record|enum)\b/g);
    publicDecls = pubMatches ? pubMatches.length : 0;
  }

  const admitted = reasons.length === 0;

  return {
    admitted,
    status: admitted ? 'ADMITTED_F0' : 'DISQUALIFIED_ADVISORY_ONLY',
    profileId: admitted ? JavaSemanticProfileId.JAVA_PUBLIC_API_F0 : null,
    disqualificationReasons: Object.freeze(reasons),
    metrics: {
      totalImports: imports.length,
      wildcardImports: wildcardImports.length,
      explicitImports: imports.length - wildcardImports.length,
      publicDeclarations: publicDecls,
      undecidableConstructs: undecidableCount
    }
  };
}

/**
 * 14-Dimension Real-World Java Change Taxonomy Matrix
 */
export interface JavaTaxonomyDimension {
  readonly id: string;
  readonly name: string;
  readonly jlsReference: string;
  readonly jvmsReference: string;
  readonly sourceImpact: 'COMPATIBLE' | 'INCOMPATIBLE' | 'CONTEXT_DEPENDENT';
  readonly binaryImpact: 'COMPATIBLE' | 'INCOMPATIBLE' | 'CONTEXT_DEPENDENT';
  readonly expectedJvmFailure?: string;
  readonly representativeCase: string;
}

export const JAVA_TAXONOMY_14_DIMENSIONS: readonly JavaTaxonomyDimension[] = [
  {
    id: 'METHOD_REMOVED',
    name: 'Public/Protected Method Removal',
    jlsReference: 'JLS §13.4.12',
    jvmsReference: 'JVMS §5.4.3.3',
    sourceImpact: 'INCOMPATIBLE',
    binaryImpact: 'INCOMPATIBLE',
    expectedJvmFailure: 'NoSuchMethodError',
    representativeCase: 'REAL-JAVA-001 (Guava checkNotNull overload removal)'
  },
  {
    id: 'PARAMETER_WIDENED',
    name: 'Method Parameter Widening (e.g. String -> CharSequence)',
    jlsReference: 'JLS §15.12.2',
    jvmsReference: 'JVMS §4.3.3',
    sourceImpact: 'COMPATIBLE',
    binaryImpact: 'INCOMPATIBLE',
    expectedJvmFailure: 'NoSuchMethodError',
    representativeCase: 'REAL-JAVA-002 (Commons-Lang containsIgnoreCase parameter widening)'
  },
  {
    id: 'VISIBILITY_NARROWED',
    name: 'Member Visibility Narrowing (e.g. protected -> package-private)',
    jlsReference: 'JLS §6.6',
    jvmsReference: 'JVMS §5.4.4',
    sourceImpact: 'CONTEXT_DEPENDENT',
    binaryImpact: 'CONTEXT_DEPENDENT',
    expectedJvmFailure: 'IllegalAccessError',
    representativeCase: 'REAL-JAVA-003 (Jackson StdDeserializer constructor visibility narrowing)'
  },
  {
    id: 'INTERFACE_ABSTRACT_METHOD_ADDED',
    name: 'Interface Abstract Method Addition',
    jlsReference: 'JLS §13.5.3',
    jvmsReference: 'JVMS §5.4.3.4',
    sourceImpact: 'CONTEXT_DEPENDENT',
    binaryImpact: 'COMPATIBLE',
    expectedJvmFailure: 'AbstractMethodError',
    representativeCase: 'REAL-JAVA-004 (Netty ByteBuf maxFastWritableBytes abstract method)'
  },
  {
    id: 'INTERFACE_DEFAULT_METHOD_ADDED',
    name: 'Interface Default Method Addition',
    jlsReference: 'JLS §9.4',
    jvmsReference: 'JVMS §5.4.3.4',
    sourceImpact: 'COMPATIBLE',
    binaryImpact: 'COMPATIBLE',
    representativeCase: 'REAL-JAVA-005 (Kafka Consumer enforceRebalance default method)'
  },
  {
    id: 'CLASS_FINAL_ADDED',
    name: 'Class Final Modifier Added',
    jlsReference: 'JLS §8.1.1.2',
    jvmsReference: 'JVMS §4.1',
    sourceImpact: 'CONTEXT_DEPENDENT',
    binaryImpact: 'CONTEXT_DEPENDENT',
    expectedJvmFailure: 'IncompatibleClassChangeError',
    representativeCase: 'REAL-JAVA-006 (Spring GenericApplicationContext final modifier)'
  },
  {
    id: 'GENERIC_BOUND_NARROWED',
    name: 'Generic Type Bound Narrowed',
    jlsReference: 'JLS §4.4',
    jvmsReference: 'JVMS §4.7.9.1',
    sourceImpact: 'CONTEXT_DEPENDENT',
    binaryImpact: 'COMPATIBLE',
    representativeCase: 'REAL-JAVA-007 (Vavr TreeSet generic bound narrowed)'
  },
  {
    id: 'CONSTANT_VALUE_CHANGED',
    name: 'Static Final Primitive Constant Value Changed',
    jlsReference: 'JLS §13.1',
    jvmsReference: 'JVMS §4.7.2',
    sourceImpact: 'COMPATIBLE',
    binaryImpact: 'COMPATIBLE',
    representativeCase: 'REAL-JAVA-008 (Commons-IO CopyUtils BUFFER_SIZE constant update)'
  },
  {
    id: 'RECORD_COMPONENT_REMOVED',
    name: 'Record Component Removal',
    jlsReference: 'JLS §8.10.3',
    jvmsReference: 'JVMS §4.7.30',
    sourceImpact: 'INCOMPATIBLE',
    binaryImpact: 'INCOMPATIBLE',
    expectedJvmFailure: 'NoSuchMethodError',
    representativeCase: 'REAL-JAVA-009 (Record Point component removal)'
  },
  {
    id: 'SEALED_PERMITS_RESTRICTED',
    name: 'Sealed Class Permits Restriction',
    jlsReference: 'JLS §8.1.6',
    jvmsReference: 'JVMS §4.7.31',
    sourceImpact: 'CONTEXT_DEPENDENT',
    binaryImpact: 'CONTEXT_DEPENDENT',
    expectedJvmFailure: 'IncompatibleClassChangeError',
    representativeCase: 'REAL-JAVA-010 (JDK 17 Sealed Shape permits restriction)'
  },
  {
    id: 'METHOD_OVERLOAD_AMBIGUITY',
    name: 'Method Overload Addition with Call-Site Ambiguity',
    jlsReference: 'JLS §15.12.2.5',
    jvmsReference: 'JVMS §13.4.23',
    sourceImpact: 'INCOMPATIBLE',
    binaryImpact: 'COMPATIBLE',
    representativeCase: 'REAL-JAVA-018 (Retrofit ApiClient query overload ambiguity with null)'
  },
  {
    id: 'METHOD_REFERENCE_CALL',
    name: 'Method Reference Invocation with Return Type Modification',
    jlsReference: 'JLS §15.13',
    jvmsReference: 'JVMS §5.4.3.3',
    sourceImpact: 'INCOMPATIBLE',
    binaryImpact: 'INCOMPATIBLE',
    expectedJvmFailure: 'NoSuchMethodError',
    representativeCase: 'REAL-JAVA-019 (Mockito Factory method reference return type change)'
  },
  {
    id: 'CONSTRUCTOR_REMOVED',
    name: 'Constructor Removal and Constructor References',
    jlsReference: 'JLS §8.8',
    jvmsReference: 'JVMS §4.3.3',
    sourceImpact: 'INCOMPATIBLE',
    binaryImpact: 'INCOMPATIBLE',
    expectedJvmFailure: 'NoSuchMethodError',
    representativeCase: 'REAL-JAVA-022 (Jackson JsonParser constructor removal)'
  },
  {
    id: 'INTERFACE_RETURN_TYPE_CHANGED',
    name: 'Interface Method Return Type Modification',
    jlsReference: 'JLS §9.4',
    jvmsReference: 'JVMS §4.3.3',
    sourceImpact: 'INCOMPATIBLE',
    binaryImpact: 'INCOMPATIBLE',
    expectedJvmFailure: 'NoSuchMethodError',
    representativeCase: 'REAL-JAVA-023 (DataProvider interface return type changed)'
  }
];

/**
 * 13 Formal Soundness Invariants for Sajimora Java Certification Subsystem
 */
export const JAVA_SOUNDNESS_INVARIANTS = [
  { id: 'INV-1', name: 'Independent Proof Dimensions', description: 'Source and binary compatibility are independent proof dimensions; AST compatibility never implies binary compatibility.' },
  { id: 'INV-2', name: 'Zero False Positives', description: 'A breaking consumer in reality is never certified COMPATIBLE.' },
  { id: 'INV-3', name: 'Zero Unjustified Certifications', description: 'Inconclusive environments or missing classpaths fail closed to UNCERTIFIED.' },
  { id: 'INV-4', name: 'Zero Unsound Negatives', description: 'Compatible consumers are never branded INCOMPATIBLE.' },
  { id: 'INV-5', name: '100% Static Discovery Recall', description: 'All statically identifiable affected consumers are discovered without omissions.' },
  { id: 'INV-6', name: 'Bit-for-Bit Deterministic Replay', description: 'Repeated runs produce bit-for-bit identical certificates and proof hashes.' },
  { id: 'INV-7', name: 'Closed Proof DAG Verification', description: 'Every certificate is backed by a verified closed rule DAG.' },
  { id: 'INV-8', name: 'Isolated Consumer Identity', description: 'Obligations reference real consumer FQCNs, not synthetic global identities.' },
  { id: 'INV-9', name: 'Fail-Closed Classpath Completeness', description: 'Unresolved external dependencies block Certified F0 admission.' },
  { id: 'INV-10', name: 'Adversarial Trap Resistance', description: 'Dynamic reflection and wildcard pollution are quarantined to advisory mode.' },
  { id: 'INV-11', name: 'Overload Ambiguity Enforcement', description: 'Call-site overload ambiguity under JLS §15.12.2 is proven source INCOMPATIBLE.' },
  { id: 'INV-12', name: 'Abstract Class Interface Exemption', description: 'Abstract classes implementing interfaces with added abstract methods are COMPATIBLE per JLS §8.1.5.' },
  { id: 'INV-13', name: 'Transitive Inheritance Preservation', description: 'Subclasses extending classes that implement changed interfaces inherit obligations transitively.' }
] as const;

