/**
 * @file TypeScriptFiniteTypeReducer.ts
 * Production-hardened Finite Type Reduction & Normalization Engine (Phase 2B).
 * 
 * Enforces:
 * 1. Finite mapped literal keys and utilities: Pick, Omit, Record, Partial, Required, Readonly.
 * 2. Strict preservation of property optionality (?) and readonly modifiers.
 * 3. Known-member indexed access and finite key unions.
 * 4. Ground non-distributive conditional type reduction.
 * 5. Finite template literal Cartesian products within defined budgets.
 * 6. Modifier-erasure attack defense (stripping readonly/optional illicitly is rejected).
 * 7. Open boundaries (any, open index signatures, distributive naked params) retain explicit UNKNOWN.
 * 8. Provenance preservation for structurally equal shapes from distinct origins.
 * 9. Shadowed utility definition detection (local utilities never confused with stdlib).
 */

export type NormalizedTypeKind =
  | 'PRIMITIVE'
  | 'LITERAL'
  | 'OBJECT'
  | 'UNION'
  | 'INTERSECTION'
  | 'NEVER'
  | 'UNKNOWN'
  | 'ANY';

export interface PropertyModifier {
  readonly isOptional: boolean;
  readonly isReadonly: boolean;
}

export interface NormalizedProperty {
  readonly name: string;
  readonly type: NormalizedTypeIR;
  readonly modifiers: PropertyModifier;
}

export interface NormalizedTypeIR {
  readonly kind: NormalizedTypeKind;
  readonly text: string;
  readonly primitiveName?: 'string' | 'number' | 'boolean' | 'symbol' | 'bigint' | 'void' | 'undefined' | 'null';
  readonly literalValue?: string | number | boolean;
  readonly properties?: ReadonlyMap<string, NormalizedProperty>;
  readonly unionBranches?: readonly NormalizedTypeIR[];
  readonly derivationProvenance?: {
    readonly originText: string;
    readonly ruleApplied: string;
    readonly intermediateSteps: readonly string[];
  };
}

export interface ReductionResult {
  readonly status: 'REDUCED' | 'TYPE_ERROR' | 'UNRESOLVED_UNKNOWN';
  readonly reducedType?: NormalizedTypeIR;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly taxonomyCode?: string;
  readonly derivationProvenance?: {
    readonly originText: string;
    readonly ruleApplied: string;
    readonly intermediateSteps: readonly string[];
  };
}

export class TypeScriptFiniteTypeReducer {
  public static readonly DEFAULT_TEMPLATE_BUDGET = 64;

  /**
   * Reduces Pick<T, K>.
   * Preserves exact property modifiers (optionality, readonly).
   * Missing keys fail closed with TS2344.
   */
  public static reducePick(
    target: NormalizedTypeIR,
    keys: readonly string[],
    provenanceText: string
  ): ReductionResult {
    if (target.kind === 'ANY') {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'ANY_TYPE_BOUNDARY_UNRESOLVED',
        errorMessage: 'Cannot reduce Pick on open any type boundary.'
      };
    }

    if (target.kind !== 'OBJECT' || !target.properties) {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'NON_OBJECT_PICK_TARGET',
        errorMessage: `Cannot Pick from non-object type: ${target.text}`
      };
    }

    const pickedProps = new Map<string, NormalizedProperty>();
    for (const k of keys) {
      const prop = target.properties.get(k);
      if (!prop) {
        return {
          status: 'TYPE_ERROR',
          errorCode: 'TS2344',
          errorMessage: `Type '"${k}"' does not satisfy the constraint 'keyof ${target.text}'. Key not found.`
        };
      }
      // Preserve exact modifiers!
      pickedProps.set(k, {
        name: k,
        type: prop.type,
        modifiers: { ...prop.modifiers }
      });
    }

    const propEntries = Array.from(pickedProps.values()).map(p =>
      `${p.modifiers.isReadonly ? 'readonly ' : ''}${p.name}${p.modifiers.isOptional ? '?' : ''}: ${p.type.text}`
    );
    const text = `{ ${propEntries.join('; ')} }`;

    return {
      status: 'REDUCED',
      reducedType: {
        kind: 'OBJECT',
        text,
        properties: pickedProps,
        derivationProvenance: {
          originText: provenanceText,
          ruleApplied: 'FINITE_UTILITY_PICK',
          intermediateSteps: [`Pick<${target.text}, ${keys.map(k => `"${k}"`).join(' | ')}> -> ${text}`]
        }
      }
    };
  }

  /**
   * Reduces Omit<T, K>.
   */
  public static reduceOmit(
    target: NormalizedTypeIR,
    omittedKeys: readonly string[],
    provenanceText: string
  ): ReductionResult {
    if (target.kind === 'ANY') {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'ANY_TYPE_BOUNDARY_UNRESOLVED',
        errorMessage: 'Cannot reduce Omit on open any type boundary.'
      };
    }

    if (target.kind !== 'OBJECT' || !target.properties) {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'NON_OBJECT_OMIT_TARGET',
        errorMessage: `Cannot Omit from non-object type: ${target.text}`
      };
    }

    const omitSet = new Set(omittedKeys);
    const retainedProps = new Map<string, NormalizedProperty>();

    for (const [k, prop] of target.properties) {
      if (!omitSet.has(k)) {
        retainedProps.set(k, {
          name: k,
          type: prop.type,
          modifiers: { ...prop.modifiers }
        });
      }
    }

    const propEntries = Array.from(retainedProps.values()).map(p =>
      `${p.modifiers.isReadonly ? 'readonly ' : ''}${p.name}${p.modifiers.isOptional ? '?' : ''}: ${p.type.text}`
    );
    const text = `{ ${propEntries.join('; ')} }`;

    return {
      status: 'REDUCED',
      reducedType: {
        kind: 'OBJECT',
        text,
        properties: retainedProps,
        derivationProvenance: {
          originText: provenanceText,
          ruleApplied: 'FINITE_UTILITY_OMIT',
          intermediateSteps: [`Omit<${target.text}, ${omittedKeys.map(k => `"${k}"`).join(' | ')}> -> ${text}`]
        }
      }
    };
  }

  /**
   * Reduces Partial<T>.
   * Turns all properties optional (isOptional = true).
   */
  public static reducePartial(
    target: NormalizedTypeIR,
    provenanceText: string
  ): ReductionResult {
    if (target.kind !== 'OBJECT' || !target.properties) {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'NON_OBJECT_PARTIAL_TARGET',
        errorMessage: `Cannot Partial non-object type: ${target.text}`
      };
    }

    const partialProps = new Map<string, NormalizedProperty>();
    for (const [k, prop] of target.properties) {
      partialProps.set(k, {
        name: k,
        type: prop.type,
        modifiers: {
          isReadonly: prop.modifiers.isReadonly,
          isOptional: true // modifier transition
        }
      });
    }

    const propEntries = Array.from(partialProps.values()).map(p =>
      `${p.modifiers.isReadonly ? 'readonly ' : ''}${p.name}?: ${p.type.text}`
    );
    const text = `{ ${propEntries.join('; ')} }`;

    return {
      status: 'REDUCED',
      reducedType: {
        kind: 'OBJECT',
        text,
        properties: partialProps,
        derivationProvenance: {
          originText: provenanceText,
          ruleApplied: 'FINITE_UTILITY_PARTIAL',
          intermediateSteps: [`Partial<${target.text}> -> ${text}`]
        }
      }
    };
  }

  /**
   * Reduces Required<T>.
   * Removes optionality (isOptional = false).
   */
  public static reduceRequired(
    target: NormalizedTypeIR,
    provenanceText: string
  ): ReductionResult {
    if (target.kind !== 'OBJECT' || !target.properties) {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'NON_OBJECT_REQUIRED_TARGET',
        errorMessage: `Cannot Required non-object type: ${target.text}`
      };
    }

    const requiredProps = new Map<string, NormalizedProperty>();
    for (const [k, prop] of target.properties) {
      requiredProps.set(k, {
        name: k,
        type: prop.type,
        modifiers: {
          isReadonly: prop.modifiers.isReadonly,
          isOptional: false // modifier transition
        }
      });
    }

    const propEntries = Array.from(requiredProps.values()).map(p =>
      `${p.modifiers.isReadonly ? 'readonly ' : ''}${p.name}: ${p.type.text}`
    );
    const text = `{ ${propEntries.join('; ')} }`;

    return {
      status: 'REDUCED',
      reducedType: {
        kind: 'OBJECT',
        text,
        properties: requiredProps,
        derivationProvenance: {
          originText: provenanceText,
          ruleApplied: 'FINITE_UTILITY_REQUIRED',
          intermediateSteps: [`Required<${target.text}> -> ${text}`]
        }
      }
    };
  }

  /**
   * Reduces Readonly<T>.
   * Adds readonly modifier (isReadonly = true).
   */
  public static reduceReadonly(
    target: NormalizedTypeIR,
    provenanceText: string
  ): ReductionResult {
    if (target.kind !== 'OBJECT' || !target.properties) {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'NON_OBJECT_READONLY_TARGET',
        errorMessage: `Cannot Readonly non-object type: ${target.text}`
      };
    }

    const readonlyProps = new Map<string, NormalizedProperty>();
    for (const [k, prop] of target.properties) {
      readonlyProps.set(k, {
        name: k,
        type: prop.type,
        modifiers: {
          isReadonly: true, // modifier transition
          isOptional: prop.modifiers.isOptional
        }
      });
    }

    const propEntries = Array.from(readonlyProps.values()).map(p =>
      `readonly ${p.name}${p.modifiers.isOptional ? '?' : ''}: ${p.type.text}`
    );
    const text = `{ ${propEntries.join('; ')} }`;

    return {
      status: 'REDUCED',
      reducedType: {
        kind: 'OBJECT',
        text,
        properties: readonlyProps,
        derivationProvenance: {
          originText: provenanceText,
          ruleApplied: 'FINITE_UTILITY_READONLY',
          intermediateSteps: [`Readonly<${target.text}> -> ${text}`]
        }
      }
    };
  }

  /**
   * Reduces Record<K, V>.
   */
  public static reduceRecord(
    keys: readonly string[],
    valueType: NormalizedTypeIR,
    provenanceText: string
  ): ReductionResult {
    const recordProps = new Map<string, NormalizedProperty>();
    for (const k of keys) {
      recordProps.set(k, {
        name: k,
        type: valueType,
        modifiers: { isOptional: false, isReadonly: false }
      });
    }

    const propEntries = Array.from(recordProps.values()).map(p => `${p.name}: ${p.type.text}`);
    const text = `{ ${propEntries.join('; ')} }`;

    return {
      status: 'REDUCED',
      reducedType: {
        kind: 'OBJECT',
        text,
        properties: recordProps,
        derivationProvenance: {
          originText: provenanceText,
          ruleApplied: 'FINITE_UTILITY_RECORD',
          intermediateSteps: [`Record<${keys.join(' | ')}, ${valueType.text}> -> ${text}`]
        }
      }
    };
  }

  /**
   * Reduces indexed access type T[K].
   */
  public static reduceIndexedAccess(
    target: NormalizedTypeIR,
    indexType: NormalizedTypeIR,
    provenanceText: string
  ): ReductionResult {
    // T[never] reduces to never
    if (indexType.kind === 'NEVER') {
      return {
        status: 'REDUCED',
        reducedType: { kind: 'NEVER', text: 'never' },
        derivationProvenance: {
          originText: provenanceText,
          ruleApplied: 'INDEXED_ACCESS_NEVER',
          intermediateSteps: [`${target.text}[never] -> never`]
        }
      };
    }

    // T[any] is an open boundary -> UNKNOWN
    if (indexType.kind === 'ANY' || target.kind === 'ANY') {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'ANY_INDEXED_ACCESS_BOUNDARY',
        errorMessage: 'Indexed access with any type is an open boundary.'
      };
    }

    if (target.kind !== 'OBJECT' || !target.properties) {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'NON_OBJECT_INDEX_TARGET',
        errorMessage: `Cannot index non-object type: ${target.text}`
      };
    }

    // Single literal key
    if (indexType.kind === 'LITERAL' && typeof indexType.literalValue === 'string') {
      const prop = target.properties.get(indexType.literalValue);
      if (!prop) {
        return {
          status: 'TYPE_ERROR',
          errorCode: 'TS2339',
          errorMessage: `Property '${indexType.literalValue}' does not exist on type '${target.text}'.`
        };
      }
      return {
        status: 'REDUCED',
        reducedType: prop.type,
        derivationProvenance: {
          originText: provenanceText,
          ruleApplied: 'INDEXED_ACCESS_MEMBER',
          intermediateSteps: [`${target.text}["${indexType.literalValue}"] -> ${prop.type.text}`]
        }
      };
    }

    // Finite key union
    if (indexType.kind === 'UNION' && indexType.unionBranches) {
      const branchTypes: NormalizedTypeIR[] = [];
      for (const branch of indexType.unionBranches) {
        if (branch.kind === 'LITERAL' && typeof branch.literalValue === 'string') {
          const prop = target.properties.get(branch.literalValue);
          if (!prop) {
            return {
              status: 'TYPE_ERROR',
              errorCode: 'TS2339',
              errorMessage: `Property '${branch.literalValue}' does not exist on type '${target.text}'.`
            };
          }
          branchTypes.push(prop.type);
        } else {
          return {
            status: 'UNRESOLVED_UNKNOWN',
            taxonomyCode: 'NON_LITERAL_UNION_KEY_IN_INDEX',
            errorMessage: 'Indexed access key union must consist purely of literal keys.'
          };
        }
      }

      const unionText = branchTypes.map(b => b.text).join(' | ');
      return {
        status: 'REDUCED',
        reducedType: {
          kind: 'UNION',
          text: unionText,
          unionBranches: branchTypes
        },
        derivationProvenance: {
          originText: provenanceText,
          ruleApplied: 'INDEXED_ACCESS_UNION_KEYS',
          intermediateSteps: [`${target.text}[${indexType.text}] -> ${unionText}`]
        }
      };
    }

    // Open index signatures (e.g. T[string]) remain UNKNOWN
    return {
      status: 'UNRESOLVED_UNKNOWN',
      taxonomyCode: 'OPEN_INDEX_SIGNATURE_UNRESOLVED',
      errorMessage: `Open index type ${indexType.text} on ${target.text} cannot be finite-reduced.`
    };
  }

  /**
   * Reduces ground non-distributive conditional types.
   * e.g. [T] extends [U] ? TrueBranch : FalseBranch
   * Distributive forms over open parameters remain UNKNOWN.
   */
  public static reduceConditional(
    checkType: NormalizedTypeIR,
    extendsType: NormalizedTypeIR,
    trueBranch: NormalizedTypeIR,
    falseBranch: NormalizedTypeIR,
    isWrapped: boolean,
    isOpenParameter: boolean,
    provenanceText: string
  ): ReductionResult {
    // Distributive conditionals over open parameters distribute over each union branch
    // and cannot be finite-reduced without ground arguments -> UNKNOWN
    if (!isWrapped && isOpenParameter) {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'DISTRIBUTIVE_CONDITIONAL_OPEN_PARAMETER',
        errorMessage: 'Distributive conditional type over open type parameter cannot be evaluated without ground argument.'
      };
    }

    // Ground non-distributive evaluation: [checkType] extends [extendsType]
    const satisfies = this.isGroundAssignable(checkType, extendsType);
    const selectedBranch = satisfies ? trueBranch : falseBranch;

    return {
      status: 'REDUCED',
      reducedType: selectedBranch,
      derivationProvenance: {
        originText: provenanceText,
        ruleApplied: isWrapped ? 'WRAPPED_NON_DISTRIBUTIVE_CONDITIONAL' : 'GROUND_CONDITIONAL_REDUCTION',
        intermediateSteps: [
          `[${checkType.text}] extends [${extendsType.text}] => ${satisfies}`,
          `Selected branch: ${selectedBranch.text}`
        ]
      }
    };
  }

  /**
   * Reduces template literal product within combinations budget.
   */
  public static reduceTemplateLiteralProduct(
    spans: readonly (readonly string[])[],
    budget: number = this.DEFAULT_TEMPLATE_BUDGET,
    provenanceText: string
  ): ReductionResult {
    // Check if any span contains an open pattern like '${string}'
    if (spans.some(span => span.includes('${string}') || span.includes('${number}'))) {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'OPEN_TEMPLATE_PATTERN_UNRESOLVED',
        errorMessage: 'Open template pattern cannot be finite-reduced.'
      };
    }

    // Compute combinations count
    let totalCombinations = 1;
    for (const span of spans) {
      totalCombinations *= span.length;
    }

    if (totalCombinations > budget) {
      return {
        status: 'UNRESOLVED_UNKNOWN',
        taxonomyCode: 'TEMPLATE_PRODUCT_BUDGET_EXHAUSTED',
        errorMessage: `Template literal product combinations (${totalCombinations}) exceeded budget of ${budget}.`
      };
    }

    // Cartesian product
    let current = [''];
    for (const span of spans) {
      const next: string[] = [];
      for (const prefix of current) {
        for (const item of span) {
          next.push(prefix + item);
        }
      }
      current = next;
    }

    const branches = current.map(str => ({
      kind: 'LITERAL' as const,
      literalValue: str,
      text: `"${str}"`
    }));

    return {
      status: 'REDUCED',
      reducedType: {
        kind: 'UNION',
        text: branches.map(b => b.text).join(' | '),
        unionBranches: branches
      },
      derivationProvenance: {
        originText: provenanceText,
        ruleApplied: 'FINITE_TEMPLATE_LITERAL_PRODUCT',
        intermediateSteps: [`Generated ${current.length} combinations within budget ${budget}`]
      }
    };
  }

  /**
   * Verifies modifier integrity to protect against modifier-erasure attacks.
   * Ensures an attacker cannot claim Pick/Omit stripped readonly or optional modifiers.
   */
  public static verifyModifierIntegrity(
    original: NormalizedProperty,
    reduced: NormalizedProperty
  ): { valid: boolean; reason?: string } {
    if (original.modifiers.isReadonly && !reduced.modifiers.isReadonly) {
      return {
        valid: false,
        reason: `Modifier-erasure attack detected: property '${original.name}' stripped readonly modifier.`
      };
    }
    if (original.modifiers.isOptional && !reduced.modifiers.isOptional) {
      return {
        valid: false,
        reason: `Modifier-erasure attack detected: property '${original.name}' stripped optional modifier.`
      };
    }
    return { valid: true };
  }

  /**
   * Detects whether a type definition shadows a TypeScript standard library utility.
   */
  public static isShadowedUtility(name: string, isDeclaredInStdLib: boolean): boolean {
    const stdLibUtilities = new Set([
      'Pick', 'Omit', 'Record', 'Partial', 'Required', 'Readonly',
      'NonNullable', 'Parameters', 'ConstructorParameters', 'ReturnType', 'InstanceType'
    ]);

    // If it has a standard name but is declared locally in user source, it is SHADOWED
    return stdLibUtilities.has(name) && !isDeclaredInStdLib;
  }

  /**
   * Ground type assignability for conditional types.
   */
  private static isGroundAssignable(source: NormalizedTypeIR, target: NormalizedTypeIR): boolean {
    if (source.text === target.text) return true;
    if (target.kind === 'ANY' || target.kind === 'UNKNOWN') return true;
    if (source.kind === 'NEVER') return true;

    if (target.kind === 'UNION' && target.unionBranches) {
      return target.unionBranches.some(b => this.isGroundAssignable(source, b));
    }

    if (source.kind === 'UNION' && source.unionBranches) {
      return source.unionBranches.every(b => this.isGroundAssignable(b, target));
    }

    if (source.kind === 'LITERAL' && target.kind === 'PRIMITIVE') {
      if (typeof source.literalValue === 'number' && target.primitiveName === 'number') return true;
      if (typeof source.literalValue === 'string' && target.primitiveName === 'string') return true;
      if (typeof source.literalValue === 'boolean' && target.primitiveName === 'boolean') return true;
    }

    return false;
  }

  /**
   * Parses a basic object type string into NormalizedTypeIR.
   */
  public static parseObjectType(typeStr: string): NormalizedTypeIR | undefined {
    const trimmed = typeStr.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
    const inner = trimmed.slice(1, -1).trim();
    const props = new Map<string, NormalizedProperty>();
    if (!inner) {
      return { kind: 'OBJECT', text: '{}', properties: props };
    }
    const parts = inner.split(/[;,]/).map(p => p.trim()).filter(Boolean);
    for (const part of parts) {
      const isReadonly = part.startsWith('readonly ');
      const rest = isReadonly ? part.slice(9).trim() : part;
      const colonIdx = rest.indexOf(':');
      if (colonIdx === -1) continue;
      const keyRaw = rest.slice(0, colonIdx).trim();
      const isOptional = keyRaw.endsWith('?');
      const name = isOptional ? keyRaw.slice(0, -1).trim() : keyRaw;
      const valTypeStr = rest.slice(colonIdx + 1).trim();
      props.set(name, {
        name,
        type: { kind: 'PRIMITIVE', text: valTypeStr },
        modifiers: { isOptional, isReadonly }
      });
    }
    return { kind: 'OBJECT', text: trimmed, properties: props };
  }

  /**
   * Normalizes finite utility types (Pick, Omit, Partial, Required, Readonly) in type strings.
   */
  public static normalizeTypeString(typeStr: string): string {
    let str = typeStr.trim();

    // Match Pick<Target, Keys>
    const pickMatch = str.match(/^Pick\s*<\s*(\{.*?\})\s*,\s*(.*?)\s*>$/);
    if (pickMatch) {
      const obj = this.parseObjectType(pickMatch[1]);
      if (obj) {
        const keys = pickMatch[2].split('|').map(k => k.trim().replace(/^['"]|['"]$/g, ''));
        const res = this.reducePick(obj, keys, str);
        if (res.status === 'REDUCED' && res.reducedType) {
          return res.reducedType.text;
        }
      }
    }

    // Match Omit<Target, Keys>
    const omitMatch = str.match(/^Omit\s*<\s*(\{.*?\})\s*,\s*(.*?)\s*>$/);
    if (omitMatch) {
      const obj = this.parseObjectType(omitMatch[1]);
      if (obj) {
        const keys = omitMatch[2].split('|').map(k => k.trim().replace(/^['"]|['"]$/g, ''));
        const res = this.reduceOmit(obj, keys, str);
        if (res.status === 'REDUCED' && res.reducedType) {
          return res.reducedType.text;
        }
      }
    }

    // Match Partial<Target>
    const partialMatch = str.match(/^Partial\s*<\s*(\{.*?\})\s*>$/);
    if (partialMatch) {
      const obj = this.parseObjectType(partialMatch[1]);
      if (obj) {
        const res = this.reducePartial(obj, str);
        if (res.status === 'REDUCED' && res.reducedType) {
          return res.reducedType.text;
        }
      }
    }

    // Match Required<Target>
    const reqMatch = str.match(/^Required\s*<\s*(\{.*?\})\s*>$/);
    if (reqMatch) {
      const obj = this.parseObjectType(reqMatch[1]);
      if (obj) {
        const res = this.reduceRequired(obj, str);
        if (res.status === 'REDUCED' && res.reducedType) {
          return res.reducedType.text;
        }
      }
    }

    // Match Readonly<Target>
    const readonlyMatch = str.match(/^Readonly\s*<\s*(\{.*?\})\s*>$/);
    if (readonlyMatch) {
      const obj = this.parseObjectType(readonlyMatch[1]);
      if (obj) {
        const res = this.reduceReadonly(obj, str);
        if (res.status === 'REDUCED' && res.reducedType) {
          return res.reducedType.text;
        }
      }
    }

    return str;
  }
}
