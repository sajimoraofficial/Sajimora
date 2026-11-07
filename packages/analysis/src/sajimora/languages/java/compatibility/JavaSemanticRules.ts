/**
 * @file JavaSemanticRules.ts
 * Nominal type compatibility rules for Java in Sajimora Phase J-3.
 */

import {
  RelationKind,
  LanguageSemanticRule,
  LanguageSemanticRuleSet,
  RelationEngineDriver,
  RelationContext,
  RuleExecutionResult
} from '@sajimora/core';
import {
  JavaTypeIR,
  isJavaUnsupported,
  containsJavaUnsupported,
  JavaPrimitiveKind
} from '../ir';

export interface JavaPolicy {
  readonly enablePrimitiveWidening?: boolean;
  readonly strictGenericInvariance?: boolean;
  readonly allowBoxingUnboxing?: boolean;
}

const PRIMITIVE_WIDENING_ORDER: Record<JavaPrimitiveKind, number> = {
  byte: 1, short: 2, char: 2, int: 3, long: 4, float: 5, double: 6, boolean: 99
};

function isValidPrimitiveWidening(source: JavaPrimitiveKind, target: JavaPrimitiveKind): boolean {
  if (source === target) return true;
  if (source === 'boolean' || target === 'boolean') return false;
  if (source === 'char') {
    return target === 'int' || target === 'long' || target === 'float' || target === 'double';
  }
  return PRIMITIVE_WIDENING_ORDER[source] < PRIMITIVE_WIDENING_ORDER[target];
}

const BOXED_MAP: Record<JavaPrimitiveKind, string> = {
  int: 'java.lang.Integer', long: 'java.lang.Long', double: 'java.lang.Double', float: 'java.lang.Float',
  boolean: 'java.lang.Boolean', byte: 'java.lang.Byte', char: 'java.lang.Character', short: 'java.lang.Short'
};

export class JavaR0CanonicalEqualityRule implements LanguageSemanticRule<JavaTypeIR, JavaPolicy> {
  public readonly id = 'JAVA_R0_CANONICAL_EQUALITY';
  public readonly name = 'Java Canonical Type IR Equality';
  public readonly priority = 0;

  public matches(source: JavaTypeIR, target: JavaTypeIR): boolean {
    if (containsJavaUnsupported(source) || containsJavaUnsupported(target)) return false;
    return source.irContentHash === target.irContentHash;
  }

  public evaluate(source: JavaTypeIR): RuleExecutionResult<JavaTypeIR> {
    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [{ premiseId: 'IDENTICAL_IR_CONTENT_HASH', description: `Hashes match: ${source.irContentHash}`, verified: true }],
      dischargedObligations: ['JAVA_TYPE_EQUALITY_DISCHARGED']
    };
  }
}

export class JavaR1VoidIdentityRule implements LanguageSemanticRule<JavaTypeIR, JavaPolicy> {
  public readonly id = 'JAVA_R1_VOID_IDENTITY';
  public readonly name = 'Java Void Identity Rule';
  public readonly priority = 1;

  public matches(source: JavaTypeIR, target: JavaTypeIR): boolean {
    return source.kind === 'JAVA_VOID' || target.kind === 'JAVA_VOID';
  }

  public evaluate(source: JavaTypeIR, target: JavaTypeIR): RuleExecutionResult<JavaTypeIR> {
    if (source.kind === 'JAVA_VOID' && target.kind === 'JAVA_VOID') {
      return {
        status: 'COMPATIBLE', ruleId: this.id,
        premises: [{ premiseId: 'BOTH_VOID', description: 'Both types are void', verified: true }],
        dischargedObligations: ['JAVA_VOID_EQUALITY_DISCHARGED']
      };
    }
    return {
      status: 'INCOMPATIBLE', ruleId: this.id,
      premises: [{ premiseId: 'VOID_MISMATCH', description: 'void mismatch', verified: false }],
      dischargedObligations: [],
      witness: { witnessKind: 'VOID_MISMATCH', source: source.display, target: target.display }
    };
  }
}

export class JavaR2PrimitiveWideningRule implements LanguageSemanticRule<JavaTypeIR, JavaPolicy> {
  public readonly id = 'JAVA_R2_PRIMITIVE_WIDENING';
  public readonly name = 'Java Primitive Widening Conversion';
  public readonly priority = 2;

  public matches(source: JavaTypeIR, target: JavaTypeIR): boolean {
    return source.kind === 'JAVA_PRIMITIVE' && target.kind === 'JAVA_PRIMITIVE';
  }

  public evaluate(source: JavaTypeIR, target: JavaTypeIR, _rel: RelationKind, policy: JavaPolicy): RuleExecutionResult<JavaTypeIR> {
    const s = (source as any).primitiveKind as JavaPrimitiveKind;
    const t = (target as any).primitiveKind as JavaPrimitiveKind;
    if (s === t) {
      return {
        status: 'COMPATIBLE', ruleId: this.id,
        premises: [{ premiseId: 'IDENTICAL_PRIMITIVE', description: `Same primitive: ${s}`, verified: true }],
        dischargedObligations: ['PRIMITIVE_IDENTITY_DISCHARGED']
      };
    }
    if (policy.enablePrimitiveWidening !== false && isValidPrimitiveWidening(s, t)) {
      return {
        status: 'COMPATIBLE', ruleId: this.id,
        premises: [{ premiseId: 'PRIMITIVE_WIDENING_VALID', description: `Widening: ${s} -> ${t}`, verified: true }],
        dischargedObligations: ['PRIMITIVE_WIDENING_DISCHARGED']
      };
    }
    return {
      status: 'INCOMPATIBLE', ruleId: this.id,
      premises: [{ premiseId: 'PRIMITIVE_CONVERSION_INVALID', description: `Cannot convert ${s} to ${t}`, verified: false }],
      dischargedObligations: [],
      witness: { witnessKind: 'PRIMITIVE_MISMATCH', source: s, target: t }
    };
  }
}
export class JavaR3PrimitiveReferenceRule implements LanguageSemanticRule<JavaTypeIR, JavaPolicy> {
  public readonly id = 'JAVA_R3_PRIMITIVE_REFERENCE';
  public readonly name = 'Java Boxing / Unboxing Rule';
  public readonly priority = 3;

  public matches(source: JavaTypeIR, target: JavaTypeIR): boolean {
    return (source.kind === 'JAVA_PRIMITIVE' && target.kind === 'JAVA_REFERENCE') ||
           (source.kind === 'JAVA_REFERENCE' && target.kind === 'JAVA_PRIMITIVE');
  }

  public evaluate(source: JavaTypeIR, target: JavaTypeIR, _rel: RelationKind, policy: JavaPolicy): RuleExecutionResult<JavaTypeIR> {
    if (policy.allowBoxingUnboxing) {
      const isBox = source.kind === 'JAVA_PRIMITIVE';
      const prim = isBox ? (source as any).primitiveKind : (target as any).primitiveKind;
      const ref = isBox ? (target as any).qualifiedName : (source as any).qualifiedName;
      const boxed = BOXED_MAP[prim as JavaPrimitiveKind];
      if (ref === boxed || ref === boxed.replace('java.lang.', '')) {
        return {
          status: 'COMPATIBLE', ruleId: this.id,
          premises: [{ premiseId: 'BOXING_VALID', description: `${prim} corresponds to ${ref}`, verified: true }],
          dischargedObligations: ['BOXING_DISCHARGED']
        };
      }
    }
    return {
      status: 'INCOMPATIBLE', ruleId: this.id,
      premises: [{ premiseId: 'BOXING_DISALLOWED_OR_MISMATCH', description: 'Primitive and reference not assignable', verified: false }],
      dischargedObligations: [],
      witness: { witnessKind: 'PRIMITIVE_REFERENCE_MISMATCH', source: source.display, target: target.display }
    };
  }
}

export class JavaR4ObjectSupertypeRule implements LanguageSemanticRule<JavaTypeIR, JavaPolicy> {
  public readonly id = 'JAVA_R4_OBJECT_SUPERTYPE';
  public readonly name = 'Java Object Universal Supertype';
  public readonly priority = 4;

  public matches(source: JavaTypeIR, target: JavaTypeIR): boolean {
    if (target.kind !== 'JAVA_REFERENCE') return false;
    const qName = (target as any).qualifiedName;
    const isObject = qName === 'java.lang.Object' || qName === 'Object';
    return isObject && (source.kind === 'JAVA_REFERENCE' || source.kind === 'JAVA_ARRAY' || source.kind === 'JAVA_WILDCARD');
  }

  public evaluate(source: JavaTypeIR): RuleExecutionResult<JavaTypeIR> {
    return {
      status: 'COMPATIBLE', ruleId: this.id,
      premises: [{ premiseId: 'OBJECT_SUPERTYPE', description: `${source.display} assignable to Object`, verified: true }],
      dischargedObligations: ['OBJECT_SUPERTYPE_DISCHARGED']
    };
  }
}

export class JavaR5ReferenceNominalRule implements LanguageSemanticRule<JavaTypeIR, JavaPolicy> {
  public readonly id = 'JAVA_R5_REFERENCE_NOMINAL';
  public readonly name = 'Java Reference Nominal Typing';
  public readonly priority = 5;

  public matches(source: JavaTypeIR, target: JavaTypeIR): boolean {
    return source.kind === 'JAVA_REFERENCE' && target.kind === 'JAVA_REFERENCE';
  }

  public evaluate(
    source: JavaTypeIR, target: JavaTypeIR, relation: RelationKind, policy: JavaPolicy,
    driver: RelationEngineDriver<JavaTypeIR, JavaPolicy>, context: RelationContext
  ): RuleExecutionResult<JavaTypeIR> {
    const sRef = source as any;
    const tRef = target as any;

    if (sRef.qualifiedName !== tRef.qualifiedName && sRef.simpleName !== tRef.simpleName) {
      return {
        status: 'INCOMPATIBLE', ruleId: this.id,
        premises: [{ premiseId: 'NOMINAL_FQCN_MISMATCH', description: `${sRef.qualifiedName} != ${tRef.qualifiedName}`, verified: false }],
        dischargedObligations: [],
        witness: { witnessKind: 'NOMINAL_TYPE_MISMATCH', source: sRef.qualifiedName, target: tRef.qualifiedName }
      };
    }

    const sArgs = sRef.typeArguments as readonly JavaTypeIR[];
    const tArgs = tRef.typeArguments as readonly JavaTypeIR[];

    if (sArgs.length !== tArgs.length) {
      return {
        status: 'INCOMPATIBLE', ruleId: this.id,
        premises: [{ premiseId: 'GENERIC_ARITY_MISMATCH', description: `Arity differs: ${sArgs.length} vs ${tArgs.length}`, verified: false }],
        dischargedObligations: [],
        witness: { witnessKind: 'GENERIC_ARITY_MISMATCH', source: sArgs.length, target: tArgs.length }
      };
    }

    if (sArgs.length === 0) {
      return {
        status: 'COMPATIBLE', ruleId: this.id,
        premises: [{ premiseId: 'NOMINAL_EXACT_MATCH', description: `Nominal reference ${sRef.qualifiedName} matches`, verified: true }],
        dischargedObligations: ['REFERENCE_NOMINAL_DISCHARGED']
      };
    }

    for (let i = 0; i < sArgs.length; i++) {
      const sa = sArgs[i];
      const ta = tArgs[i];
      if (ta.kind === 'JAVA_WILDCARD') {
        const w = ta as any;
        if (w.bound === 'UNBOUNDED') continue;
        if (w.bound === 'UPPER' && w.boundType) {
          const sub = driver.evaluateSubRelation(sa, w.boundType, relation, policy, { ...context, depth: (context.depth ?? 0) + 1 }) as any;
          if (sub.status !== 'COMPATIBLE') return sub;
          continue;
        }
        if (w.bound === 'LOWER' && w.boundType) {
          const sub = driver.evaluateSubRelation(w.boundType, sa, relation, policy, { ...context, depth: (context.depth ?? 0) + 1 }) as any;
          if (sub.status !== 'COMPATIBLE') return sub;
          continue;
        }
      }

      const sub = driver.evaluateSubRelation(sa, ta, 'IDENTICAL_TO', policy, { ...context, depth: (context.depth ?? 0) + 1 }) as any;
      if (sub.status !== 'COMPATIBLE') return sub;
    }

    return {
      status: 'COMPATIBLE', ruleId: this.id,
      premises: [{ premiseId: 'GENERIC_ARGUMENTS_COMPATIBLE', description: 'Generic arguments compatible', verified: true }],
      dischargedObligations: ['GENERIC_ARGUMENTS_DISCHARGED']
    };
  }
}
export class JavaR6ArrayCompatibilityRule implements LanguageSemanticRule<JavaTypeIR, JavaPolicy> {
  public readonly id = 'JAVA_R6_ARRAY_COMPATIBILITY';
  public readonly name = 'Java Array Subtyping';
  public readonly priority = 6;

  public matches(source: JavaTypeIR, target: JavaTypeIR): boolean {
    return source.kind === 'JAVA_ARRAY' && target.kind === 'JAVA_ARRAY';
  }

  public evaluate(
    source: JavaTypeIR, target: JavaTypeIR, relation: RelationKind, policy: JavaPolicy,
    driver: RelationEngineDriver<JavaTypeIR, JavaPolicy>, context: RelationContext
  ): RuleExecutionResult<JavaTypeIR> {
    const sArr = source as any;
    const tArr = target as any;
    if (sArr.dimensions !== tArr.dimensions) {
      return {
        status: 'INCOMPATIBLE', ruleId: this.id,
        premises: [{ premiseId: 'ARRAY_DIMENSION_MISMATCH', description: `Dimensions ${sArr.dimensions} != ${tArr.dimensions}`, verified: false }],
        dischargedObligations: [],
        witness: { witnessKind: 'ARRAY_DIMENSION_MISMATCH', source: sArr.dimensions, target: tArr.dimensions }
      };
    }
    return driver.evaluateSubRelation(sArr.elementType, tArr.elementType, relation, policy, { ...context, depth: (context.depth ?? 0) + 1 }) as any;
  }
}

export class JavaR7WildcardSubtypingRule implements LanguageSemanticRule<JavaTypeIR, JavaPolicy> {
  public readonly id = 'JAVA_R7_WILDCARD_SUBTYPING';
  public readonly name = 'Java Wildcard Subtyping';
  public readonly priority = 7;

  public matches(source: JavaTypeIR, target: JavaTypeIR): boolean {
    return source.kind === 'JAVA_WILDCARD' || target.kind === 'JAVA_WILDCARD';
  }

  public evaluate(source: JavaTypeIR, target: JavaTypeIR): RuleExecutionResult<JavaTypeIR> {
    if (target.kind === 'JAVA_WILDCARD' && (target as any).bound === 'UNBOUNDED') {
      return {
        status: 'COMPATIBLE', ruleId: this.id,
        premises: [{ premiseId: 'UNBOUNDED_WILDCARD_MATCH', description: 'Unbounded wildcard accepts all types', verified: true }],
        dischargedObligations: ['WILDCARD_DISCHARGED']
      };
    }
    return {
      status: 'UNDECIDABLE', ruleId: this.id,
      premises: [{ premiseId: 'WILDCARD_COMPLEXITY', description: 'Wildcard requires generic context', verified: false }],
      dischargedObligations: []
    };
  }
}

export class JavaR99UnsupportedFallbackRule implements LanguageSemanticRule<JavaTypeIR, JavaPolicy> {
  public readonly id = 'JAVA_R99_UNSUPPORTED_FALLBACK';
  public readonly name = 'Java Unsupported Type Blocker';
  public readonly priority = 99;

  public matches(source: JavaTypeIR, target: JavaTypeIR): boolean {
    return containsJavaUnsupported(source) || containsJavaUnsupported(target);
  }

  public evaluate(source: JavaTypeIR, target: JavaTypeIR): RuleExecutionResult<JavaTypeIR> {
    const isSource = isJavaUnsupported(source);
    const un = (isSource ? source : target) as any;
    return {
      status: 'UNDECIDABLE', ruleId: this.id,
      premises: [{ premiseId: 'JAVA_UNSUPPORTED_BLOCKED', description: `Unsupported Java type: ${un.reason}`, verified: false }],
      dischargedObligations: [],
      blockers: [{ blockerId: 'JAVA_UNSUPPORTED_TYPE_BLOCKED', snapshot: isSource ? 'PARENT' : 'CANDIDATE', reason: un.reason }]
    };
  }
}

export class JavaSemanticRuleSet implements LanguageSemanticRuleSet<JavaTypeIR, JavaPolicy> {
  public readonly rules: ReadonlyArray<LanguageSemanticRule<JavaTypeIR, JavaPolicy>>;

  constructor() {
    this.rules = [
      new JavaR0CanonicalEqualityRule(),
      new JavaR1VoidIdentityRule(),
      new JavaR2PrimitiveWideningRule(),
      new JavaR3PrimitiveReferenceRule(),
      new JavaR4ObjectSupertypeRule(),
      new JavaR5ReferenceNominalRule(),
      new JavaR6ArrayCompatibilityRule(),
      new JavaR7WildcardSubtypingRule(),
      new JavaR99UnsupportedFallbackRule()
    ].sort((a, b) => a.priority - b.priority);
  }

  public selectRule(source: JavaTypeIR, target: JavaTypeIR, relation: RelationKind, policy: JavaPolicy): LanguageSemanticRule<JavaTypeIR, JavaPolicy> | null {
    for (const rule of this.rules) {
      if (rule.matches(source, target, relation, policy)) return rule;
    }
    return null;
  }
}


