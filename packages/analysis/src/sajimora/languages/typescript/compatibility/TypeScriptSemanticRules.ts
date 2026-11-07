import {
  RelationKind,
  RelationStatus,
  LanguageSemanticRule,
  LanguageSemanticRuleSet,
  RelationEngineDriver,
  RelationContext,
  RuleExecutionResult,
  IncompatibilityWitness
} from '@sajimora/core';
import {
  TypeScriptTypeIR,
  containsAny,
  hasSemanticAnyDependency,
  containsUnsupported,
  ObjectTypeIR,
  TupleTypeIR,
  CallableTypeIR
} from '../ir/TypeScriptTypeIR';
import { WitnessGenerator } from '../../../compatibility/WitnessGenerator';
import { TypeScriptVarianceComposer } from './TypeScriptVarianceComposer';

export interface TypeScriptPolicy {
  readonly strictFunctionTypes: boolean;
  readonly strictNullChecks: boolean;
}

export class TypeScriptSemanticRuleSet implements LanguageSemanticRuleSet<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly rules: ReadonlyArray<LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy>>;

  constructor() {
    this.rules = [
      new TSR0CanonicalEqualityRule(),
      new TSR1NeverSourceRule(),
      new TSR2UnknownTargetRule(),
      new TSR3AnyDependencyRule(),
      new TSR4PrimitiveIdentityRule(),
      new TSR5LiteralToPrimitiveRule(),
      new TSR6NullUndefinedRule(),
      new TSR7UnionSourceRule(),
      new TSR8UnionTargetRule(),
      new TSR9IntersectionSourceRule(),
      new TSR10IntersectionTargetRule(),
      new TSR11TupleArrayRule(),
      new TSR12ObjectStructuralRule(),
      new TSR13CallableSubtypingRule(),
      new TSR14GenericReferenceRule(),
      new TSR15RecursionBackreferenceRule(),
      new TSR16ConditionalTypeRule(),
      new TSR17MappedTypeRule(),
      new TSR18IndexedAccessRule(),
      new TSR19TemplateLiteralRule(),
      new TSR99UnsupportedFallbackRule()
    ].sort((a, b) => a.priority - b.priority);
  }

  public selectRule(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind,
    policy: TypeScriptPolicy
  ): LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> | null {
    for (const rule of this.rules) {
      if (rule.matches(source, target, relation, policy)) {
        return rule;
      }
    }
    return null;
  }
}

// R0: Canonical Equality (excludes any and unsupported)
export class TSR0CanonicalEqualityRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R0_CANONICAL_EQUALITY';
  public readonly name = 'Canonical Type IR Equality';
  public readonly priority = 0;

  public matches(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    _relation: RelationKind,
    _policy: TypeScriptPolicy
  ): boolean {
    if (containsUnsupported(source) || containsUnsupported(target)) {
      return false;
    }
    if (hasSemanticAnyDependency(source, target)) {
      return false;
    }
    return source.irContentHash === target.irContentHash;
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    _relation: RelationKind,
    _policy: TypeScriptPolicy
  ): RuleExecutionResult<TypeScriptTypeIR> {
    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [
        {
          premiseId: 'IDENTICAL_IR_CONTENT_HASH',
          description: `Hashes match: ${source.irContentHash}`,
          verified: true
        }
      ],
      dischargedObligations: ['TYPE_EQUALITY_DISCHARGED']
    };
  }
}

// R1: never source
export class TSR1NeverSourceRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R1_NEVER_SOURCE';
  public readonly name = 'Bottom Type never Assignability';
  public readonly priority = 1;

  public matches(source: TypeScriptTypeIR): boolean {
    return source.kind === 'PRIMITIVE' && source.primitiveKind === 'never';
  }

  public evaluate(): RuleExecutionResult<TypeScriptTypeIR> {
    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [{ premiseId: 'NEVER_BOTTOM_TYPE', description: 'never is assignable to all types', verified: true }],
      dischargedObligations: ['BOTTOM_TYPE_ASSIGNABILITY']
    };
  }
}

// R2: unknown target
export class TSR2UnknownTargetRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R2_UNKNOWN_TARGET';
  public readonly name = 'Top Type unknown Assignability';
  public readonly priority = 2;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    if (source.kind === 'PRIMITIVE' && source.primitiveKind === 'any') return false;
    return target.kind === 'PRIMITIVE' && target.primitiveKind === 'unknown';
  }

  public evaluate(): RuleExecutionResult<TypeScriptTypeIR> {
    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [{ premiseId: 'UNKNOWN_TOP_TYPE', description: 'All types are assignable to unknown', verified: true }],
      dischargedObligations: ['TOP_TYPE_ASSIGNABILITY']
    };
  }
}

// R3: any Dependency
export class TSR3AnyDependencyRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R3_ANY_DEPENDENCY';
  public readonly name = 'any Dependency Fail-Closed Guard';
  public readonly priority = 3;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return (
      hasSemanticAnyDependency(source, target) ||
      (source.irContentHash !== target.irContentHash && (containsAny(source) || containsAny(target)))
    );
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const srcAny = containsAny(source);
    const tgtAny = containsAny(target);

    let blockerId: 'ANY_DEPENDENCY_BOTH' | 'ANY_DEPENDENCY_SOURCE' | 'ANY_DEPENDENCY_TARGET' = 'ANY_DEPENDENCY_BOTH';
    if (srcAny && !tgtAny) blockerId = 'ANY_DEPENDENCY_SOURCE';
    else if (!srcAny && tgtAny) blockerId = 'ANY_DEPENDENCY_TARGET';

    return {
      status: 'UNDECIDABLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      anyDependency: true,
      blockers: [
        {
          blockerId,
          snapshot: 'PARENT',
          detail: `Relation depends on any type: ${blockerId}`,
          sourceIRContentHash: source.irContentHash,
          targetIRContentHash: target.irContentHash
        }
      ]
    };
  }
}

// R4: Primitive Identity and Mismatch
export class TSR4PrimitiveIdentityRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R4_PRIMITIVE_IDENTITY';
  public readonly name = 'Primitive Type Identity and Mismatch';
  public readonly priority = 4;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    if (source.kind === 'PRIMITIVE' && target.kind === 'PRIMITIVE') {
      return true;
    }
    if (
      source.kind === 'PRIMITIVE' &&
      source.primitiveKind === 'unknown' &&
      (target.kind !== 'PRIMITIVE' || target.primitiveKind !== 'unknown')
    ) {
      return true;
    }
    return false;
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const srcKind = (source as any).primitiveKind;
    const tgtKind = (target as any).primitiveKind;

    if (source.kind === 'PRIMITIVE' && target.kind === 'PRIMITIVE' && (srcKind === tgtKind || (srcKind === 'undefined' && tgtKind === 'void'))) {
      return {
        status: 'COMPATIBLE',
        ruleId: this.id,
        premises: [
          {
            premiseId: 'PRIMITIVE_KIND_MATCH',
            description: `Primitive kinds match or undefined to void: ${srcKind} -> ${tgtKind}`,
            verified: true
          }
        ],
        dischargedObligations: ['PRIMITIVE_ASSIGNABILITY']
      };
    }

    const witness = WitnessGenerator.createWitness({
      consumerLocation: { file: '', line: 1, column: 1 },
      targetDeclaration: { file: '', line: 1, column: 1 },
      semanticRelation: relation,
      position: { kind: 'ROOT' },
      parentType: { display: source.display, irContentHash: source.irContentHash },
      candidateType: { display: target.display, irContentHash: target.irContentHash },
      failedRelation: `Type '${source.display}' is not assignable to type '${target.display}'`,
      ruleId: this.id
    });

    return {
      status: 'INCOMPATIBLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      witness
    };
  }
}

// R5: Literal to Primitive
export class TSR5LiteralToPrimitiveRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R5_LITERAL_TO_PRIMITIVE';
  public readonly name = 'Literal to Base Primitive Subtyping';
  public readonly priority = 5;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    if (source.kind === 'LITERAL' && target.kind === 'PRIMITIVE') {
      return true;
    }
    if (source.kind === 'PRIMITIVE' && target.kind === 'LITERAL') {
      return true;
    }
    if (source.kind === 'LITERAL' && target.kind === 'LITERAL') {
      return true;
    }
    return false;
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind
  ): RuleExecutionResult<TypeScriptTypeIR> {
    if (source.kind === 'LITERAL' && target.kind === 'PRIMITIVE') {
      if (source.literalKind === target.primitiveKind) {
        return {
          status: 'COMPATIBLE',
          ruleId: this.id,
          premises: [
            {
              premiseId: 'LITERAL_SUBTYPE_MATCH',
              description: `Literal ${source.literalKind} extends base primitive ${target.primitiveKind}`,
              verified: true
            }
          ],
          dischargedObligations: ['LITERAL_WIDENING']
        };
      }
      const witness = WitnessGenerator.createWitness({
        consumerLocation: { file: '', line: 1, column: 1 },
        targetDeclaration: { file: '', line: 1, column: 1 },
        semanticRelation: relation,
        position: { kind: 'ROOT' },
        parentType: { display: source.display, irContentHash: source.irContentHash },
        candidateType: { display: target.display, irContentHash: target.irContentHash },
        failedRelation: `Literal type ${source.display} (${source.literalKind}) is not assignable to primitive ${target.display}`,
        ruleId: this.id
      });
      return {
        status: 'INCOMPATIBLE',
        ruleId: this.id,
        premises: [],
        dischargedObligations: [],
        witness
      };
    }

    if (source.kind === 'LITERAL' && target.kind === 'LITERAL') {
      const srcEnum = (source as any).enumOrigin;
      const tgtEnum = (target as any).enumOrigin;
      if (srcEnum || tgtEnum) {
        if (srcEnum !== tgtEnum) {
          const witness = WitnessGenerator.createWitness({
            consumerLocation: { file: '', line: 1, column: 1 },
            targetDeclaration: { file: '', line: 1, column: 1 },
            semanticRelation: relation,
            position: { kind: 'ROOT' },
            parentType: { display: source.display, irContentHash: source.irContentHash },
            candidateType: { display: target.display, irContentHash: target.irContentHash },
            failedRelation: `Enum member '${source.display}' is not assignable to distinct enum '${target.display}'`,
            ruleId: this.id
          });
          return {
            status: 'INCOMPATIBLE',
            ruleId: this.id,
            premises: [],
            dischargedObligations: [],
            witness
          };
        }
      }

      if (source.literalKind === target.literalKind && source.value === target.value) {
        return {
          status: 'COMPATIBLE',
          ruleId: this.id,
          premises: [
            {
              premiseId: 'LITERAL_VALUE_MATCH',
              description: `Literal value ${source.value} matches target`,
              verified: true
            }
          ],
          dischargedObligations: ['LITERAL_EQUALITY']
        };
      }
      const witness = WitnessGenerator.createWitness({
        consumerLocation: { file: '', line: 1, column: 1 },
        targetDeclaration: { file: '', line: 1, column: 1 },
        semanticRelation: relation,
        position: { kind: 'ROOT' },
        parentType: { display: source.display, irContentHash: source.irContentHash },
        candidateType: { display: target.display, irContentHash: target.irContentHash },
        failedRelation: `Literal type ${source.display} is not assignable to literal type ${target.display}`,
        ruleId: this.id
      });
      return {
        status: 'INCOMPATIBLE',
        ruleId: this.id,
        premises: [],
        dischargedObligations: [],
        witness
      };
    }

    // Source is primitive, target is literal -> INCOMPATIBLE
    const witness = WitnessGenerator.createWitness({
      consumerLocation: { file: '', line: 1, column: 1 },
      targetDeclaration: { file: '', line: 1, column: 1 },
      semanticRelation: relation,
      position: { kind: 'ROOT' },
      parentType: { display: source.display, irContentHash: source.irContentHash },
      candidateType: { display: target.display, irContentHash: target.irContentHash },
      failedRelation: `Base primitive ${source.display} cannot be narrowed to literal ${target.display}`,
      ruleId: this.id
    });

    return {
      status: 'INCOMPATIBLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      witness
    };
  }
}

// R6: Null / Undefined Subtyping
export class TSR6NullUndefinedRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R6_NULL_UNDEFINED';
  public readonly name = 'Null/Undefined Assignability';
  public readonly priority = 6;

  public matches(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    _relation: RelationKind,
    policy: TypeScriptPolicy
  ): boolean {
    if (!policy.strictNullChecks) {
      if (source.kind === 'PRIMITIVE' && (source.primitiveKind === 'null' || source.primitiveKind === 'undefined')) {
        return target.kind !== 'PRIMITIVE' || target.primitiveKind !== 'never';
      }
    }
    return false;
  }

  public evaluate(): RuleExecutionResult<TypeScriptTypeIR> {
    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [
        {
          premiseId: 'STRICT_NULL_CHECKS_DISABLED',
          description: 'Under strictNullChecks: false, null/undefined is assignable to all types',
          verified: true
        }
      ],
      dischargedObligations: ['NULL_UNDEFINED_ASSIGNABILITY']
    };
  }
}

// R7: Union Source
export class TSR7UnionSourceRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R7_UNION_SOURCE';
  public readonly name = 'Union Source Distribution';
  public readonly priority = 7;

  public matches(source: TypeScriptTypeIR): boolean {
    return source.kind === 'UNION';
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind,
    policy: TypeScriptPolicy,
    _driver: RelationEngineDriver<TypeScriptTypeIR, TypeScriptPolicy>,
    context: RelationContext
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const union = source as import('../ir/TypeScriptTypeIR').UnionTypeIR;
    const subRelations = union.members.map(member => ({
      source: member,
      target,
      relation,
      policy,
      context
    }));

    return {
      status: 'COMPATIBLE', // will be aggregated
      ruleId: this.id,
      premises: [
        {
          premiseId: 'UNION_SOURCE_CONJUNCTION',
          description: 'All union members must be assignable to target',
          verified: true
        }
      ],
      dischargedObligations: ['UNION_SOURCE_DISTRIBUTION'],
      subRelations,
      aggregationMode: 'UNIVERSAL_CONJUNCTION'
    };
  }
}

// R8: Union Target
export class TSR8UnionTargetRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R8_UNION_TARGET';
  public readonly name = 'Union Target Disjunction';
  public readonly priority = 8;

  public matches(_source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return target.kind === 'UNION';
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind,
    policy: TypeScriptPolicy,
    _driver: RelationEngineDriver<TypeScriptTypeIR, TypeScriptPolicy>,
    context: RelationContext
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const union = target as import('../ir/TypeScriptTypeIR').UnionTypeIR;
    const subRelations = union.members.map(member => ({
      source,
      target: member,
      relation,
      policy,
      context
    }));

    return {
      status: 'COMPATIBLE', // will be aggregated
      ruleId: this.id,
      premises: [
        {
          premiseId: 'UNION_TARGET_DISJUNCTION',
          description: 'At least one target union member must accept source',
          verified: true
        }
      ],
      dischargedObligations: ['UNION_TARGET_DISJUNCTION'],
      subRelations,
      aggregationMode: 'EXISTENTIAL_DISJUNCTION'
    };
  }
}

// R9: Intersection Source
export class TSR9IntersectionSourceRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R9_INTERSECTION_SOURCE';
  public readonly name = 'Intersection Source Subtyping';
  public readonly priority = 9;

  public matches(source: TypeScriptTypeIR): boolean {
    return source.kind === 'INTERSECTION';
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind,
    policy: TypeScriptPolicy,
    _driver: RelationEngineDriver<TypeScriptTypeIR, TypeScriptPolicy>,
    context: RelationContext
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const isect = source as import('../ir/TypeScriptTypeIR').IntersectionTypeIR;
    // If any member is assignable to target, intersection is assignable
    const subRelations = isect.members.map(member => ({
      source: member,
      target,
      relation,
      policy,
      context
    }));

    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [
        {
          premiseId: 'INTERSECTION_SOURCE_DISJUNCTION',
          description: 'At least one intersection constituent must satisfy target',
          verified: true
        }
      ],
      dischargedObligations: ['INTERSECTION_SOURCE_SATISFACTION'],
      subRelations,
      aggregationMode: 'EXISTENTIAL_DISJUNCTION'
    };
  }
}

// R10: Intersection Target
export class TSR10IntersectionTargetRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R10_INTERSECTION_TARGET';
  public readonly name = 'Intersection Target Conjunction';
  public readonly priority = 10;

  public matches(_source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return target.kind === 'INTERSECTION';
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind,
    policy: TypeScriptPolicy,
    _driver: RelationEngineDriver<TypeScriptTypeIR, TypeScriptPolicy>,
    context: RelationContext
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const isect = target as import('../ir/TypeScriptTypeIR').IntersectionTypeIR;
    const subRelations = isect.members.map(member => ({
      source,
      target: member,
      relation,
      policy,
      context
    }));

    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [
        {
          premiseId: 'INTERSECTION_TARGET_CONJUNCTION',
          description: 'Source must satisfy all intersection constituents',
          verified: true
        }
      ],
      dischargedObligations: ['INTERSECTION_TARGET_SATISFACTION'],
      subRelations,
      aggregationMode: 'UNIVERSAL_CONJUNCTION'
    };
  }
}

// R11: Tuple / Array
export class TSR11TupleArrayRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R11_TUPLE_ARRAY';
  public readonly name = 'Tuple and Array Subtyping';
  public readonly priority = 11;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return (
      (source.kind === 'TUPLE' || source.kind === 'ARRAY') &&
      (target.kind === 'TUPLE' || target.kind === 'ARRAY')
    );
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind,
    policy: TypeScriptPolicy,
    _driver: RelationEngineDriver<TypeScriptTypeIR, TypeScriptPolicy>,
    context: RelationContext
  ): RuleExecutionResult<TypeScriptTypeIR> {
    // Array to Array
    if (source.kind === 'ARRAY' && target.kind === 'ARRAY') {
      return {
        status: 'COMPATIBLE',
        ruleId: this.id,
        premises: [{ premiseId: 'ARRAY_ELEMENT_CHECK', description: 'Array elements checked', verified: true }],
        dischargedObligations: ['ARRAY_SUBTYPING'],
        subRelations: [
          {
            source: source.elementType,
            target: target.elementType,
            relation: 'ASSIGNABLE_TO',
            policy,
            context
          }
        ],
        aggregationMode: 'UNIVERSAL_CONJUNCTION'
      };
    }

    // Tuple to Array
    if (source.kind === 'TUPLE' && target.kind === 'ARRAY') {
      const subRelations = source.elements.map(e => ({
        source: e.type,
        target: target.elementType,
        relation: 'ASSIGNABLE_TO' as RelationKind,
        policy,
        context
      }));
      return {
        status: 'COMPATIBLE',
        ruleId: this.id,
        premises: [{ premiseId: 'TUPLE_TO_ARRAY', description: 'All tuple elements assignable to array element', verified: true }],
        dischargedObligations: ['TUPLE_TO_ARRAY_ASSIGNABILITY'],
        subRelations,
        aggregationMode: 'UNIVERSAL_CONJUNCTION'
      };
    }

    // Tuple to Tuple
    if (source.kind === 'TUPLE' && target.kind === 'TUPLE') {
      // 1. Mutability check: readonly tuple cannot be assigned to mutable tuple
      if (source.isReadonly && !target.isReadonly) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: '', line: 1, column: 1 },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: relation,
          position: { kind: 'ROOT' },
          parentType: { display: source.display, irContentHash: source.irContentHash },
          candidateType: { display: target.display, irContentHash: target.irContentHash },
          failedRelation: 'The type is readonly and cannot be assigned to the mutable type',
          ruleId: this.id
        });
        return {
          status: 'INCOMPATIBLE',
          ruleId: this.id,
          premises: [],
          dischargedObligations: [],
          witness
        };
      }

      // 2. Minimum length check
      if (source.minLength < target.minLength) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: '', line: 1, column: 1 },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: relation,
          position: { kind: 'TUPLE_ELEMENT', index: source.minLength },
          parentType: { display: source.display, irContentHash: source.irContentHash },
          candidateType: { display: target.display, irContentHash: target.irContentHash },
          failedRelation: `Tuple minLength ${source.minLength} is less than target required minLength ${target.minLength}`,
          ruleId: this.id
        });
        return {
          status: 'INCOMPATIBLE',
          ruleId: this.id,
          premises: [],
          dischargedObligations: [],
          witness
        };
      }

      // 3. Shape and maximum length check
      if (!target.hasRest) {
        if (source.hasRest) {
          const witness = WitnessGenerator.createWitness({
            consumerLocation: { file: '', line: 1, column: 1 },
            targetDeclaration: { file: '', line: 1, column: 1 },
            semanticRelation: relation,
            position: { kind: 'ROOT' },
            parentType: { display: source.display, irContentHash: source.irContentHash },
            candidateType: { display: target.display, irContentHash: target.irContentHash },
            failedRelation: 'Source tuple has rest element but target tuple has fixed length',
            ruleId: this.id
          });
          return {
            status: 'INCOMPATIBLE',
            ruleId: this.id,
            premises: [],
            dischargedObligations: [],
            witness
          };
        }
        if (source.elements.length > target.elements.length) {
          const witness = WitnessGenerator.createWitness({
            consumerLocation: { file: '', line: 1, column: 1 },
            targetDeclaration: { file: '', line: 1, column: 1 },
            semanticRelation: relation,
            position: { kind: 'TUPLE_ELEMENT', index: target.elements.length },
            parentType: { display: source.display, irContentHash: source.irContentHash },
            candidateType: { display: target.display, irContentHash: target.irContentHash },
            failedRelation: `Source tuple has ${source.elements.length} elements but target tuple allows at most ${target.elements.length}`,
            ruleId: this.id
          });
          return {
            status: 'INCOMPATIBLE',
            ruleId: this.id,
            premises: [],
            dischargedObligations: [],
            witness
          };
        }
      }

      const subRelations: any[] = [];
      const targetRestEl = target.hasRest ? target.elements[target.elements.length - 1] : undefined;
      const maxLen = Math.max(source.elements.length, target.elements.length);

      for (let i = 0; i < maxLen; i++) {
        const srcEl = i < source.elements.length ? source.elements[i] : undefined;
        const tgtEl = i < target.elements.length ? target.elements[i] : targetRestEl;

        if (srcEl && tgtEl) {
          subRelations.push({
            source: srcEl.type,
            target: tgtEl.type,
            relation: 'ASSIGNABLE_TO' as RelationKind,
            policy,
            context
          });
        }
      }

      return {
        status: 'COMPATIBLE',
        ruleId: this.id,
        premises: [{ premiseId: 'TUPLE_ELEMENTS_CHECK', description: 'Tuple elements checked', verified: true }],
        dischargedObligations: ['TUPLE_SUBTYPING'],
        subRelations,
        aggregationMode: 'UNIVERSAL_CONJUNCTION'
      };
    }

    // Array to Tuple -> Incompatible
    const witness = WitnessGenerator.createWitness({
      consumerLocation: { file: '', line: 1, column: 1 },
      targetDeclaration: { file: '', line: 1, column: 1 },
      semanticRelation: relation,
      position: { kind: 'ROOT' },
      parentType: { display: source.display, irContentHash: source.irContentHash },
      candidateType: { display: target.display, irContentHash: target.irContentHash },
      failedRelation: 'General Array cannot be assigned to fixed-length Tuple',
      ruleId: this.id
    });
    return {
      status: 'INCOMPATIBLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      witness
    };
  }
}

// R12: Object Structural Decomposition
export class TSR12ObjectStructuralRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R12_OBJECT_STRUCTURAL';
  public readonly name = 'Object Structural Complete Obligation Decomposition';
  public readonly priority = 12;

  public matches(_source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return target.kind === 'OBJECT';
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind,
    policy: TypeScriptPolicy,
    _driver: RelationEngineDriver<TypeScriptTypeIR, TypeScriptPolicy>,
    context: RelationContext
  ): RuleExecutionResult<TypeScriptTypeIR> {
    if (source.kind !== 'OBJECT') {
      const witness = WitnessGenerator.createWitness({
        consumerLocation: { file: '', line: 1, column: 1 },
        targetDeclaration: { file: '', line: 1, column: 1 },
        semanticRelation: relation,
        position: { kind: 'ROOT' },
        parentType: { display: source.display, irContentHash: source.irContentHash },
        candidateType: { display: target.display, irContentHash: target.irContentHash },
        failedRelation: `Type ${source.display} is not an object type required by target`,
        ruleId: this.id
      });
      return {
        status: 'INCOMPATIBLE',
        ruleId: this.id,
        premises: [],
        dischargedObligations: [],
        witness
      };
    }

    const srcObj = source as ObjectTypeIR;
    const tgtObj = target as ObjectTypeIR;

    // 1. Private / Protected Member Origins check
    if (tgtObj.nominalOrigins && tgtObj.nominalOrigins.length > 0) {
      const srcOrigins = srcObj.nominalOrigins ?? [];
      const hasAllOrigins = tgtObj.nominalOrigins.every(o => srcOrigins.includes(o));
      if (!hasAllOrigins) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: '', line: 1, column: 1 },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: relation,
          position: { kind: 'ROOT' },
          parentType: { display: source.display, irContentHash: source.irContentHash },
          candidateType: { display: target.display, irContentHash: target.irContentHash },
          failedRelation: 'Private/protected member origin mismatch between unrelated classes',
          ruleId: this.id
        });
        return {
          status: 'INCOMPATIBLE',
          ruleId: this.id,
          premises: [],
          dischargedObligations: [],
          witness
        };
      }
    }

    // 2. Excess property checking on fresh literals (§6.12.3)
    const isFresh = Boolean((srcObj as any).isFreshLiteral);
    const tgtPropMap = new Map<string, import('../ir/TypeScriptTypeIR').TypeScriptPropertyDescriptorIR>(tgtObj.properties);
    const hasIndexSignature = Boolean(tgtObj.indexSignatures && tgtObj.indexSignatures.length > 0);

    if (isFresh && !hasIndexSignature) {
      for (const [srcPropName] of srcObj.properties) {
        if (!tgtPropMap.has(srcPropName)) {
          const witness = WitnessGenerator.createWitness({
            consumerLocation: { file: '', line: 1, column: 1 },
            targetDeclaration: { file: '', line: 1, column: 1 },
            semanticRelation: relation,
            position: { kind: 'PROPERTY', name: srcPropName },
            parentType: { display: source.display, irContentHash: source.irContentHash },
            candidateType: { display: target.display, irContentHash: target.irContentHash },
            failedRelation: `Excess property '${srcPropName}' rejected on fresh object literal`,
            ruleId: this.id
          });
          return {
            status: 'INCOMPATIBLE',
            ruleId: this.id,
            premises: [],
            dischargedObligations: [],
            witness
          };
        }
      }
    }

    // 3. Complete obligation decomposition:
    const subRelations: any[] = [];
    const srcPropMap = new Map(srcObj.properties);

    // Increase structural progress guard depth for child properties!
    const structuralContext: RelationContext = {
      ...context,
      structuralGuardDepth: (context.structuralGuardDepth ?? 0) + 1
    };

    for (const [propName, tgtDesc] of tgtObj.properties) {
      const srcDesc = srcPropMap.get(propName);
      if (!srcDesc) {
        if (!tgtDesc.isOptional) {
          // Required property missing -> INCOMPATIBLE
          const witness = WitnessGenerator.createWitness({
            consumerLocation: { file: '', line: 1, column: 1 },
            targetDeclaration: { file: '', line: 1, column: 1 },
            semanticRelation: relation,
            position: { kind: 'PROPERTY', name: propName },
            parentType: { display: source.display, irContentHash: source.irContentHash },
            candidateType: { display: target.display, irContentHash: target.irContentHash },
            failedRelation: `Required property '${propName}' is missing from source`,
            ruleId: this.id
          });
          return {
            status: 'INCOMPATIBLE',
            ruleId: this.id,
            premises: [],
            dischargedObligations: [],
            witness
          };
        }
      } else {
        // Property present in both: check if target requires it but source makes it optional
        if (!tgtDesc.isOptional && srcDesc.isOptional) {
          const witness = WitnessGenerator.createWitness({
            consumerLocation: { file: '', line: 1, column: 1 },
            targetDeclaration: { file: '', line: 1, column: 1 },
            semanticRelation: relation,
            position: { kind: 'PROPERTY', name: propName },
            parentType: { display: source.display, irContentHash: source.irContentHash },
            candidateType: { display: target.display, irContentHash: target.irContentHash },
            failedRelation: `Required property '${propName}' is optional in source`,
            ruleId: this.id
          });
          return {
            status: 'INCOMPATIBLE',
            ruleId: this.id,
            premises: [],
            dischargedObligations: [],
            witness
          };
        }

        // Property present in both: sub-relation
        subRelations.push({
          source: srcDesc.type,
          target: tgtDesc.type,
          relation: 'PROPERTY_READ_SAFE' as RelationKind,
          policy,
          context: structuralContext
        });
      }
    }

    // 4. Call signatures decomposition
    if (tgtObj.callSignatures && tgtObj.callSignatures.length > 0) {
      if (!srcObj.callSignatures || srcObj.callSignatures.length === 0) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: '', line: 1, column: 1 },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: relation,
          position: { kind: 'ROOT' },
          parentType: { display: source.display, irContentHash: source.irContentHash },
          candidateType: { display: target.display, irContentHash: target.irContentHash },
          failedRelation: 'Target requires call signatures but source object is not callable',
          ruleId: this.id
        });
        return {
          status: 'INCOMPATIBLE',
          ruleId: this.id,
          premises: [],
          dischargedObligations: [],
          witness
        };
      }
      for (const tgtSig of tgtObj.callSignatures) {
        const matchingSrcSig = srcObj.callSignatures[0];
        const srcRequired = matchingSrcSig.parameters.filter(p => p.isRequired).length;
        if (srcRequired > tgtSig.parameters.length && !tgtSig.parameters.some(p => p.isRest)) {
          const witness = WitnessGenerator.createWitness({
            consumerLocation: { file: '', line: 1, column: 1 },
            targetDeclaration: { file: '', line: 1, column: 1 },
            semanticRelation: relation,
            position: { kind: 'ROOT' },
            parentType: { display: source.display, irContentHash: source.irContentHash },
            candidateType: { display: target.display, irContentHash: target.irContentHash },
            failedRelation: `Source call signature requires ${srcRequired} arguments but target provides at most ${tgtSig.parameters.length}`,
            ruleId: this.id
          });
          return {
            status: 'INCOMPATIBLE',
            ruleId: this.id,
            premises: [],
            dischargedObligations: [],
            witness
          };
        }

        // Parameters contravariance
        for (let i = 0; i < Math.min(matchingSrcSig.parameters.length, tgtSig.parameters.length); i++) {
          subRelations.push({
            source: tgtSig.parameters[i].type,
            target: matchingSrcSig.parameters[i].type,
            relation: 'CALLBACK_PARAMETER_SAFE' as RelationKind,
            policy,
            context: structuralContext
          });
        }
        // Return covariance (unless target return is void, which indicates discarded return)
        const isTargetVoid = tgtSig.returnType.kind === 'PRIMITIVE' && (tgtSig.returnType as any).primitiveKind === 'void';
        if (!isTargetVoid) {
          subRelations.push({
            source: matchingSrcSig.returnType,
            target: tgtSig.returnType,
            relation: 'RETURN_SATISFIES_CONTEXT' as RelationKind,
            policy,
            context: structuralContext
          });
        }
      }
    }

    // 5. Construct signatures decomposition
    if (tgtObj.constructSignatures && tgtObj.constructSignatures.length > 0) {
      if (!srcObj.constructSignatures || srcObj.constructSignatures.length === 0) {
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: '', line: 1, column: 1 },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: relation,
          position: { kind: 'ROOT' },
          parentType: { display: source.display, irContentHash: source.irContentHash },
          candidateType: { display: target.display, irContentHash: target.irContentHash },
          failedRelation: 'Target requires construct signature but source object has no construct signatures',
          ruleId: this.id
        });
        return {
          status: 'INCOMPATIBLE',
          ruleId: this.id,
          premises: [],
          dischargedObligations: [],
          witness
        };
      }
      for (const tgtConstruct of tgtObj.constructSignatures) {
        const matchingSrcConstruct = srcObj.constructSignatures[0];
        for (let i = 0; i < Math.min(matchingSrcConstruct.parameters.length, tgtConstruct.parameters.length); i++) {
          subRelations.push({
            source: tgtConstruct.parameters[i].type,
            target: matchingSrcConstruct.parameters[i].type,
            relation: 'CALLBACK_PARAMETER_SAFE' as RelationKind,
            policy,
            context: structuralContext
          });
        }
        subRelations.push({
          source: matchingSrcConstruct.returnType,
          target: tgtConstruct.returnType,
          relation: 'RETURN_SATISFIES_CONTEXT' as RelationKind,
          policy,
          context: structuralContext
        });
      }
    }

    // 6. Index signatures decomposition
    if (tgtObj.indexSignatures && tgtObj.indexSignatures.length > 0) {
      for (const tgtIdx of tgtObj.indexSignatures) {
        const matchingSrcIdx = srcObj.indexSignatures?.find(s => s.keyType === tgtIdx.keyType);
        if (matchingSrcIdx) {
          subRelations.push({
            source: matchingSrcIdx.valueType,
            target: tgtIdx.valueType,
            relation: 'PROPERTY_READ_SAFE' as RelationKind,
            policy,
            context: structuralContext
          });
        } else {
          // Check if explicit properties violate index signature value type
          for (const [propName, propDesc] of srcObj.properties) {
            const keyMatches = tgtIdx.keyType === 'string' || /^\d+$/.test(propName);
            if (keyMatches) {
              subRelations.push({
                source: propDesc.type,
                target: tgtIdx.valueType,
                relation: 'PROPERTY_READ_SAFE' as RelationKind,
                policy,
                context: structuralContext
              });
            }
          }
        }
      }
    }

    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [
        {
          premiseId: 'COMPLETE_OBLIGATION_DECOMPOSITION',
          description: 'All structural property and signature sub-obligations verified',
          verified: true
        }
      ],
      dischargedObligations: ['STRUCTURAL_OBJECT_ASSIGNABILITY'],
      subRelations,
      aggregationMode: 'UNIVERSAL_CONJUNCTION'
    };
  }
}

// R13: Callable / Function Subtyping
export class TSR13CallableSubtypingRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R13_CALLABLE_SUBTYPING';
  public readonly name = 'Callable Signature Subtyping';
  public readonly priority = 13;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return (
      (source.kind === 'CALLABLE' || (source.kind === 'OBJECT' && (source as ObjectTypeIR).callSignatures?.length! > 0)) &&
      (target.kind === 'CALLABLE' || (target.kind === 'OBJECT' && (target as ObjectTypeIR).callSignatures?.length! > 0))
    );
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind,
    policy: TypeScriptPolicy,
    _driver: RelationEngineDriver<TypeScriptTypeIR, TypeScriptPolicy>,
    context: RelationContext
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const srcSigs = source.kind === 'CALLABLE' ? (source as CallableTypeIR).signatures : (source as ObjectTypeIR).callSignatures!;
    const tgtSigs = target.kind === 'CALLABLE' ? (target as CallableTypeIR).signatures : (target as ObjectTypeIR).callSignatures!;

    if (!srcSigs || srcSigs.length === 0 || !tgtSigs || tgtSigs.length === 0) {
      const witness = WitnessGenerator.createWitness({
        consumerLocation: { file: '', line: 1, column: 1 },
        targetDeclaration: { file: '', line: 1, column: 1 },
        semanticRelation: relation,
        position: { kind: 'ROOT' },
        parentType: { display: source.display, irContentHash: source.irContentHash },
        candidateType: { display: target.display, irContentHash: target.irContentHash },
        failedRelation: 'Callable signatures missing',
        ruleId: this.id
      });
      return { status: 'INCOMPATIBLE', ruleId: this.id, premises: [], dischargedObligations: [], witness };
    }

    const subRelations: any[] = [];
    const structuralContext: RelationContext = {
      ...context,
      structuralGuardDepth: (context.structuralGuardDepth ?? 0) + 1
    };

    // Every required target signature must be satisfied by a matching source signature
    for (let tIdx = 0; tIdx < tgtSigs.length; tIdx++) {
      const tgtSig = tgtSigs[tIdx];
      const tgtHasRest = tgtSig.parameters.some(p => p.isRest);
      const tgtTotal = tgtSig.parameters.length;

      // Find candidate source signatures capable of accepting this tgtSig call
      const candidateSrcSigs = srcSigs.filter(sig => {
        const srcRequired = sig.parameters.filter(p => p.isRequired).length;
        if (!tgtHasRest && srcRequired > tgtTotal) return false;
        return true;
      });

      if (candidateSrcSigs.length === 0) {
        const srcRequired = srcSigs[0]?.parameters.filter(p => p.isRequired).length ?? 0;
        const failedMsg = tgtSigs.length === 1
          ? `Callback source requires ${srcRequired} arguments but target caller supplies at most ${tgtTotal}`
          : `Target overload #${tIdx + 1} has ${tgtTotal} parameters but no source signature can accept it`;
        const witness = WitnessGenerator.createWitness({
          consumerLocation: { file: '', line: 1, column: 1 },
          targetDeclaration: { file: '', line: 1, column: 1 },
          semanticRelation: relation,
          position: { kind: 'ROOT' },
          parentType: { display: source.display, irContentHash: source.irContentHash },
          candidateType: { display: target.display, irContentHash: target.irContentHash },
          failedRelation: failedMsg,
          ruleId: this.id
        });
        return {
          status: 'INCOMPATIBLE',
          ruleId: this.id,
          premises: [],
          dischargedObligations: [],
          witness
        };
      }

      // Pair with the candidate source signature
      const srcSig = candidateSrcSigs[0];

      // For all parameters that source expects:
      for (let i = 0; i < srcSig.parameters.length; i++) {
        const srcP = srcSig.parameters[i];
        let tgtParamType: TypeScriptTypeIR | undefined;
        if (i < tgtSig.parameters.length) {
          tgtParamType = tgtSig.parameters[i].type;
        } else if (tgtHasRest) {
          const restP = tgtSig.parameters[tgtSig.parameters.length - 1];
          tgtParamType = restP.type.kind === 'ARRAY' ? (restP.type as any).elementType : restP.type;
        } else {
          if (srcP.isRequired) {
            const witness = WitnessGenerator.createWitness({
              consumerLocation: { file: '', line: 1, column: 1 },
              targetDeclaration: { file: '', line: 1, column: 1 },
              semanticRelation: relation,
              position: { kind: 'PARAMETER', index: i, name: srcP.name },
              parentType: { display: source.display, irContentHash: source.irContentHash },
              candidateType: { display: target.display, irContentHash: target.irContentHash },
              failedRelation: `Callback parameter '${srcP.name}' is required but not provided by caller in target overload #${tIdx + 1}`,
              ruleId: this.id
            });
            return {
              status: 'INCOMPATIBLE',
              ruleId: this.id,
              premises: [],
              dischargedObligations: [],
              witness
            };
          }
        }

        if (tgtParamType) {
          if (policy.strictFunctionTypes) {
            subRelations.push({
              source: tgtParamType,
              target: srcP.type,
              relation: 'CALLBACK_PARAMETER_SAFE' as RelationKind,
              policy,
              context: structuralContext
            });
          } else {
            subRelations.push({
              source: srcP.type,
              target: tgtParamType,
              relation: 'CALLBACK_PARAMETER_SAFE' as RelationKind,
              policy,
              context: structuralContext
            });
          }
        }
      }

      // Return: Covariant (unless target return is void, which indicates discarded return)
      const isTargetVoid = tgtSig.returnType.kind === 'PRIMITIVE' && (tgtSig.returnType as any).primitiveKind === 'void';
      if (!isTargetVoid) {
        subRelations.push({
          source: srcSig.returnType,
          target: tgtSig.returnType,
          relation: 'CALLBACK_RETURN_SAFE' as RelationKind,
          policy,
          context: structuralContext
        });
      }
    }

    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [
        {
          premiseId: 'CALLABLE_SUBTYPING_VERIFIED',
          description: 'Callable signature subtyping verified',
          verified: true
        }
      ],
      dischargedObligations: ['FUNCTION_SUBTYPING'],
      subRelations,
      aggregationMode: 'UNIVERSAL_CONJUNCTION'
    };
  }
}

// R14: Generic Reference
export class TSR14GenericReferenceRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R14_GENERIC_REFERENCE';
  public readonly name = 'Instantiated Generic Type Reference Subtyping';
  public readonly priority = 14;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return source.kind === 'TYPE_REFERENCE' && target.kind === 'TYPE_REFERENCE';
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind,
    policy: TypeScriptPolicy,
    _driver: RelationEngineDriver<TypeScriptTypeIR, TypeScriptPolicy>,
    context: RelationContext
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const srcRef = source as import('../ir/TypeScriptTypeIR').TypeReferenceIR;
    const tgtRef = target as import('../ir/TypeScriptTypeIR').TypeReferenceIR;

    if (srcRef.targetDefinitionHash !== tgtRef.targetDefinitionHash) {
      const witness = WitnessGenerator.createWitness({
        consumerLocation: { file: '', line: 1, column: 1 },
        targetDeclaration: { file: '', line: 1, column: 1 },
        semanticRelation: relation,
        position: { kind: 'ROOT' },
        parentType: { display: source.display, irContentHash: source.irContentHash },
        candidateType: { display: target.display, irContentHash: target.irContentHash },
        failedRelation: 'Target definition content hashes differ between snapshots',
        ruleId: this.id
      });
      return {
        status: 'INCOMPATIBLE',
        ruleId: this.id,
        premises: [],
        dischargedObligations: [],
        witness
      };
    }

    const srcArgs = srcRef.typeArguments ?? [];
    const tgtArgs = tgtRef.typeArguments ?? [];
    const subRelations: any[] = [];

    for (let i = 0; i < Math.min(srcArgs.length, tgtArgs.length); i++) {
      subRelations.push({
        source: srcArgs[i],
        target: tgtArgs[i],
        relation: 'ASSIGNABLE_TO' as RelationKind,
        policy,
        context
      });
    }

    return {
      status: 'COMPATIBLE',
      ruleId: this.id,
      premises: [{ premiseId: 'GENERIC_ARGS_CHECK', description: 'Generic arguments checked', verified: true }],
      dischargedObligations: ['GENERIC_REFERENCE_SATISFACTION'],
      subRelations,
      aggregationMode: 'UNIVERSAL_CONJUNCTION'
    };
  }
}

// R15: Recursion Backreference
export class TSR15RecursionBackreferenceRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R15_RECURSION_BACKREFERENCE';
  public readonly name = 'Recursion Backreference Coinductive Evaluation';
  public readonly priority = 15;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return source.kind === 'RECURSION_BACKREFERENCE' && target.kind === 'RECURSION_BACKREFERENCE';
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const srcBack = source as import('../ir/TypeScriptTypeIR').RecursionBackreferenceIR;
    const tgtBack = target as import('../ir/TypeScriptTypeIR').RecursionBackreferenceIR;

    const sameScope = srcBack.scopeBindingId === tgtBack.scopeBindingId;
    const srcArgs = srcBack.instantiatedTypeArgumentHashes ?? [];
    const tgtArgs = tgtBack.instantiatedTypeArgumentHashes ?? [];
    const sameArgs = srcArgs.length === tgtArgs.length && srcArgs.every((h, i) => h === tgtArgs[i]);

    if (sameScope && sameArgs) {
      return {
        status: 'COMPATIBLE',
        ruleId: this.id,
        premises: [{ premiseId: 'BACKREFERENCE_MATCH', description: 'Backreference scope and instantiated arguments matched', verified: true }],
        dischargedObligations: ['RECURSION_BACKREFERENCE_EQUALITY']
      };
    }

    return {
      status: 'UNDECIDABLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      blockers: [
        {
          blockerId: 'UNGUARDED_RECURSIVE_CYCLE',
          snapshot: 'PARENT',
          detail: sameScope
            ? 'Recursive backreference instantiated generic arguments mismatch'
            : 'Mismatched recursion backreference scopes'
        }
      ]
    };
  }
}

// R16: Conditional Type
export class TSR16ConditionalTypeRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R16_CONDITIONAL';
  public readonly name = 'Conditional Type Reduction';
  public readonly priority = 16;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return source.kind === 'CONDITIONAL' || target.kind === 'CONDITIONAL';
  }

  public evaluate(): RuleExecutionResult<TypeScriptTypeIR> {
    return {
      status: 'UNDECIDABLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      blockers: [
        {
          blockerId: 'CONDITIONAL_TYPE_NOT_REDUCIBLE',
          snapshot: 'PARENT',
          detail: 'Unreducible conditional type encountered'
        }
      ]
    };
  }
}

// R17: Mapped Type
export class TSR17MappedTypeRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R17_MAPPED';
  public readonly name = 'Mapped Type Reduction';
  public readonly priority = 17;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return source.kind === 'MAPPED' || target.kind === 'MAPPED';
  }

  public evaluate(): RuleExecutionResult<TypeScriptTypeIR> {
    return {
      status: 'UNDECIDABLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      blockers: [
        {
          blockerId: 'MAPPED_TYPE_OPEN_KEY_SPACE',
          snapshot: 'PARENT',
          detail: 'Mapped type with open key space cannot be statically expanded'
        }
      ]
    };
  }
}

// R18: Indexed Access
export class TSR18IndexedAccessRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R18_INDEXED_ACCESS';
  public readonly name = 'Indexed Access Resolution';
  public readonly priority = 18;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return source.kind === 'INDEXED_ACCESS' || target.kind === 'INDEXED_ACCESS';
  }

  public evaluate(): RuleExecutionResult<TypeScriptTypeIR> {
    return {
      status: 'UNDECIDABLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      blockers: [
        {
          blockerId: 'INDEXED_ACCESS_KEY_UNKNOWN',
          snapshot: 'PARENT',
          detail: 'Indexed access key cannot be concretely resolved'
        }
      ]
    };
  }
}

// R19: Template Literal
export class TSR19TemplateLiteralRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R19_TEMPLATE_LITERAL';
  public readonly name = 'Template Literal Type Evaluation';
  public readonly priority = 19;

  public matches(source: TypeScriptTypeIR, target: TypeScriptTypeIR): boolean {
    return source.kind === 'TEMPLATE_LITERAL' || target.kind === 'TEMPLATE_LITERAL';
  }

  public evaluate(): RuleExecutionResult<TypeScriptTypeIR> {
    return {
      status: 'UNDECIDABLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      blockers: [
        {
          blockerId: 'TEMPLATE_LITERAL_OPEN_PATTERN',
          snapshot: 'PARENT',
          detail: 'Open template literal interpolation pattern cannot be decided'
        }
      ]
    };
  }
}

// R99: Unsupported Fallback
export class TSR99UnsupportedFallbackRule implements LanguageSemanticRule<TypeScriptTypeIR, TypeScriptPolicy> {
  public readonly id = 'TS_R99_UNSUPPORTED_FALLBACK';
  public readonly name = 'Universal Unsupported Fallback Guard';
  public readonly priority = 99;

  public matches(): boolean {
    return true;
  }

  public evaluate(
    source: TypeScriptTypeIR,
    target: TypeScriptTypeIR,
    relation: RelationKind
  ): RuleExecutionResult<TypeScriptTypeIR> {
    const isUnsupportedNode = source.kind === 'UNSUPPORTED' || target.kind === 'UNSUPPORTED';
    const blockerId = isUnsupportedNode
      ? 'TYPE_IR_EXTRACTION_UNSUPPORTED'
      : 'UNSUPPORTED_TYPE_RELATION';

    return {
      status: 'UNDECIDABLE',
      ruleId: this.id,
      premises: [],
      dischargedObligations: [],
      blockers: [
        {
          blockerId,
          snapshot: 'PARENT',
          detail: `Unsupported type relation ${relation} between ${source.display} and ${target.display}`,
          sourceIRContentHash: source.irContentHash,
          targetIRContentHash: target.irContentHash
        }
      ]
    };
  }
}
