import { WireType, ValidationConstraint } from './CanonicalContractIR';

export interface WireMismatch { path: string; supplied: string; accepted: string }
export interface DirectionalComparison { mismatches: WireMismatch[]; unresolved: string[] }

export type WireEvaluationDirection = 'PRODUCER_TO_CONSUMER' | 'CONSUMER_TO_PRODUCER';

export interface DirectionalWireOptions {
  path?: string;
  depth?: number;
  budget?: { checks: number };
  direction?: WireEvaluationDirection;
  parsesOutboundData?: boolean;
}

/**
 * Derives the input wire type for a schema (e.g. z.input<T>).
 * On input, properties with .default(v) accept undefined/missing from the producer.
 */
export function toInputWireType(type: WireType): WireType {
  if (!type) return type;
  switch (type.kind) {
    case 'OBJECT': {
      const properties = type.properties.map(p => {
        const transformedType = toInputWireType(p.type);
        if (p.hasDefault) {
          return {
            ...p,
            type: transformedType,
            optional: true,
          };
        }
        return {
          ...p,
          type: transformedType,
        };
      });
      return {
        ...type,
        properties,
      };
    }
    case 'ARRAY':
      return {
        ...type,
        elementType: toInputWireType(type.elementType),
        ...(type.tupleElements ? { tupleElements: type.tupleElements.map(toInputWireType) } : {}),
      };
    case 'UNION':
      return {
        ...type,
        types: type.types.map(toInputWireType),
      };
    case 'NULLABLE':
      return {
        ...type,
        innerType: toInputWireType(type.innerType),
      };
    case 'OPTIONAL':
      return {
        ...type,
        innerType: toInputWireType(type.innerType),
      };
    case 'MAP':
      return {
        ...type,
        keyType: toInputWireType(type.keyType),
        valueType: toInputWireType(type.valueType),
      };
    default:
      return type;
  }
}

/**
 * Derives the output wire type for a schema (e.g. z.output<T>).
 * On output, properties with .default(v) are guaranteed present (optional: false) unless an outer modifier is optional.
 */
export function toOutputWireType(type: WireType): WireType {
  if (!type) return type;
  switch (type.kind) {
    case 'OBJECT': {
      const properties = type.properties.map(p => {
        const transformedType = toOutputWireType(p.type);
        if (p.hasDefault) {
          return {
            ...p,
            type: transformedType,
            optional: p.outputOptional ?? false,
          };
        }
        return {
          ...p,
          type: transformedType,
        };
      });
      return {
        ...type,
        properties,
      };
    }
    case 'ARRAY':
      return {
        ...type,
        elementType: toOutputWireType(type.elementType),
        ...(type.tupleElements ? { tupleElements: type.tupleElements.map(toOutputWireType) } : {}),
      };
    case 'UNION':
      return {
        ...type,
        types: type.types.map(toOutputWireType),
      };
    case 'NULLABLE':
      return {
        ...type,
        innerType: toOutputWireType(type.innerType),
      };
    case 'OPTIONAL':
      return {
        ...type,
        innerType: toOutputWireType(type.innerType),
      };
    case 'MAP':
      return {
        ...type,
        keyType: toOutputWireType(type.keyType),
        valueType: toOutputWireType(type.valueType),
      };
    default:
      return type;
  }
}

/** Every encoded producer value must be accepted by the consumer. Unknown domains fail closed. */
export function compareDirectionalWire(
  source: WireType,
  target: WireType,
  pathOrOptionsOrDirection: string | WireEvaluationDirection | DirectionalWireOptions = '$',
  depth = 0,
  budget = { checks: 0 },
  explicitDirection?: WireEvaluationDirection
): DirectionalComparison {
  let path = '$';
  let direction: WireEvaluationDirection = explicitDirection ?? 'PRODUCER_TO_CONSUMER';
  let parsesOutboundData = true;

  if (typeof pathOrOptionsOrDirection === 'string') {
    if (pathOrOptionsOrDirection === 'PRODUCER_TO_CONSUMER' || pathOrOptionsOrDirection === 'CONSUMER_TO_PRODUCER') {
      direction = pathOrOptionsOrDirection;
      path = '$';
    } else {
      path = pathOrOptionsOrDirection;
      if (!explicitDirection) {
        if (path.startsWith('request')) {
          direction = 'CONSUMER_TO_PRODUCER';
        } else {
          direction = 'PRODUCER_TO_CONSUMER';
        }
      }
    }
  } else if (typeof pathOrOptionsOrDirection === 'object' && pathOrOptionsOrDirection !== null) {
    path = pathOrOptionsOrDirection.path ?? '$';
    depth = pathOrOptionsOrDirection.depth ?? depth;
    budget = pathOrOptionsOrDirection.budget ?? budget;
    if (pathOrOptionsOrDirection.direction) {
      direction = pathOrOptionsOrDirection.direction;
    }
    if (pathOrOptionsOrDirection.parsesOutboundData !== undefined) {
      parsesOutboundData = pathOrOptionsOrDirection.parsesOutboundData;
    }
  }

  let effectiveSource = source;
  let effectiveTarget = target;

  if (depth === 0) {
    if (direction === 'PRODUCER_TO_CONSUMER') {
      effectiveTarget = toInputWireType(target);
    } else if (direction === 'CONSUMER_TO_PRODUCER') {
      if (parsesOutboundData) {
        effectiveSource = toOutputWireType(source);
      } else {
        effectiveSource = toInputWireType(source);
      }
    }
  }

  const mismatches: WireMismatch[] = [];
  const unresolved: string[] = [];
  const mismatch = (at: string, supplied: string, accepted: string) => mismatches.push({ path: at, supplied, accepted });
  const describe = (type: WireType) => type.kind === 'PRIMITIVE' ? type.scalar : type.kind;
  const validation = (type: WireType, constraints: readonly ValidationConstraint[], at: string) => {
    for (const constraint of constraints) {
      if (constraint.kind === 'NOT_NULL') continue;
      const values = type.kind === 'LITERAL' ? [type.value] : type.kind === 'ENUM' ? type.values : undefined;
      if (!values) { unresolved.push(`Validation ${constraint.kind} at ${at} is not proved for every supplied value`); continue; }
      for (const value of values) {
        let accepted: boolean | undefined;
        switch (constraint.kind) {
          case 'NOT_BLANK': accepted = typeof value === 'string' && value.trim().length > 0; break;
          case 'NOT_EMPTY': accepted = typeof value === 'string' && value.length > 0; break;
          case 'MIN': if (typeof constraint.value === 'number' && typeof value === 'number') accepted = value >= constraint.value; break;
          case 'MAX': if (typeof constraint.value === 'number' && typeof value === 'number') accepted = value <= constraint.value; break;
        }
        if (accepted === false) mismatch(at, JSON.stringify(value), constraint.kind);
        else if (accepted === undefined) unresolved.push(`Unsupported validation ${constraint.kind} at ${at}`);
      }
    }
  };
  const check = (s: WireType, t: WireType, at: string, level = depth): void => {
    if (level > 80 || ++budget.checks > 10000) { unresolved.push(`Wire comparison budget exceeded at ${at}`); return; }
    if (s.kind === 'UNKNOWN' || t.kind === 'UNKNOWN' || s.kind === 'PRIMITIVE' && s.scalar === 'any' || t.kind === 'PRIMITIVE' && t.scalar === 'any') { unresolved.push(`Unknown wire domain at ${at}`); return; }
    if (s.kind === 'ENUM') { for (const value of s.values) check({ kind: 'LITERAL', value }, t, at, level + 1); return; }
    if ((s.kind === 'NULLABLE' || s.kind === 'OPTIONAL') && s.innerType.kind === 'UNION') { for (const member of s.innerType.types) check({ kind: s.kind, innerType: member }, t, at, level + 1); return; }
    if (s.kind === 'UNION') { for (const member of s.types) check(member, t, at, level + 1); return; }
    if (t.kind === 'UNION') {
      const choices = t.types.map(member => compareDirectionalWire(s, member, { path: at, depth: level + 1, budget, direction, parsesOutboundData }));
      if (choices.some(c => !c.mismatches.length && !c.unresolved.length)) return;
      if (choices.some(c => !c.mismatches.length)) unresolved.push(`Union acceptance unresolved at ${at}`);
      else mismatch(at, describe(s), 'one of the accepted union members');
      return;
    }
    if (s.kind === 'OPTIONAL') {
      if (t.kind !== 'OPTIONAL') mismatch(at, 'possibly omitted', describe(t));
      check(s.innerType, t.kind === 'OPTIONAL' ? t.innerType : t, at, level + 1); return;
    }
    if (t.kind === 'OPTIONAL') { check(s, t.innerType, at, level + 1); return; }
    if (s.kind === 'NULLABLE') {
      if (t.kind !== 'NULLABLE') mismatch(at, 'possibly null', describe(t));
      check(s.innerType, t.kind === 'NULLABLE' ? t.innerType : t, at, level + 1); return;
    }
    if (t.kind === 'NULLABLE') { check(s, t.innerType, at, level + 1); return; }
    if (s.kind === 'LITERAL') {
      const values = [s.value];
      for (const value of values) {
        if (t.kind === 'LITERAL' && value === t.value || t.kind === 'ENUM' && t.values.includes(value as string | number) || t.kind === 'PRIMITIVE' && typeof value === t.scalar) continue;
        mismatch(at, JSON.stringify(value), describe(t));
      }
      return;
    }
    if (t.kind === 'LITERAL' || t.kind === 'ENUM') { mismatch(at, describe(s), 'restricted literal domain'); return; }
    if (s.kind !== t.kind) { mismatch(at, describe(s), describe(t)); return; }
    if (s.kind === 'PRIMITIVE' && t.kind === 'PRIMITIVE') {
      if (s.scalar === 'bigint' || t.scalar === 'bigint') unresolved.push(`JSON encoding of bigint is unqualified at ${at}`);
      else if (s.scalar !== t.scalar) mismatch(at, s.scalar, t.scalar);
    } else if (s.kind === 'ARRAY' && t.kind === 'ARRAY') check(s.elementType, t.elementType, at + '[*]', level + 1);
    else if (s.kind === 'MAP' && t.kind === 'MAP') { check(s.keyType, t.keyType, at + '{key}', level + 1); check(s.valueType, t.valueType, at + '.*', level + 1); }
    else if (s.kind === 'OBJECT' && t.kind === 'OBJECT') {
      const supplied = new Map(s.properties.map(p => [p.wireName, p]));
      const accepted = new Map(t.properties.map(p => [p.wireName, p]));
      for (const property of t.properties) {
        const value = supplied.get(property.wireName);
        const propPath = `${at}.${property.wireName}`;
        if (!value) {
          const acceptedOptional = property.optional || (direction === 'PRODUCER_TO_CONSUMER' && !!property.hasDefault);
          if (!acceptedOptional) mismatch(propPath, 'missing property', 'required property');
          continue;
        }
        const valueOptional = value.optional && !(direction === 'CONSUMER_TO_PRODUCER' && parsesOutboundData && value.hasDefault && !value.outputOptional);
        const targetOptional = property.optional || (direction === 'PRODUCER_TO_CONSUMER' && !!property.hasDefault);
        if (valueOptional && !targetOptional) mismatch(propPath, 'possibly omitted', 'required property');
        check(value.nullable && value.type.kind !== 'NULLABLE' ? { kind: 'NULLABLE', innerType: value.type } : value.type,
          property.nullable && property.type.kind !== 'NULLABLE' ? { kind: 'NULLABLE', innerType: property.type } : property.type, propPath, level + 1);
        validation(value.type, property.validationConstraints, propPath);
      }
      if (t.strict) for (const property of s.properties) if (!accepted.has(property.wireName)) mismatch(`${at}.${property.wireName}`, 'extra property', 'strict object (.strict())');
    } else unresolved.push(`Unsupported wire domain at ${at}`);
  };
  check(effectiveSource, effectiveTarget, path);
  return { mismatches, unresolved };
}
