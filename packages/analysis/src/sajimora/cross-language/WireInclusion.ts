import { WireType, WirePropertyContract } from './CanonicalContractIR';

export interface WireIssue { path: string; reason: string; before: string; after: string; unresolved: boolean }
const issue = (path: string, reason: string, before: string, after: string, unresolved = false): WireIssue => ({ path, reason, before, after, unresolved });

/** Normalize field metadata once: optional means omitted, never null. */
export function propertyType(p: WirePropertyContract): WireType {
  let type = p.type;
  if (p.nullable && type.kind !== 'NULLABLE') type = { kind: 'NULLABLE', innerType: type };
  if (p.optional && type.kind !== 'OPTIONAL') type = { kind: 'OPTIONAL', innerType: type };
  return type;
}
function unwrap(t: WireType): { inner: WireType; nullable: boolean; optional: boolean } {
  let nullable = false, optional = false;
  while (t.kind === 'NULLABLE' || t.kind === 'OPTIONAL') {
    if (t.kind === 'NULLABLE') nullable = true; else optional = true;
    t = t.innerType;
  }
  return { inner: t, nullable, optional };
}

function wrap(t:WireType, nullable:boolean, optional:boolean):WireType { if(nullable)t={kind:'NULLABLE',innerType:t}; if(optional)t={kind:'OPTIONAL',innerType:t}; return t; }

/** All values of produced must be admitted by accepted. Unsupported facts remain unresolved. */
export function wireInclusion(produced: WireType, accepted: WireType, path = '$', depth = 0): WireIssue[] {
  if (depth > 80) return [issue(path, 'wire recursion budget exceeded', produced.kind, accepted.kind, true)];
  const p = unwrap(produced), a = unwrap(accepted);
  if (p.inner.kind === 'UNKNOWN' || a.inner.kind === 'UNKNOWN' ||
      (p.inner.kind === 'PRIMITIVE' && p.inner.scalar === 'any') ||
      (a.inner.kind === 'PRIMITIVE' && a.inner.scalar === 'any')) {
    return [issue(path, 'wire contract is unresolved', p.inner.kind, a.inner.kind, true)];
  }
  // Include null/omission in union branches as well as wrapper metadata.
  if (a.inner.kind === 'UNION') {
    const trials = a.inner.types.map(t => wireInclusion(produced, wrap(t, a.nullable, a.optional), path, depth + 1));
    if (trials.some(t => t.length === 0)) return [];
    // A produced union can be covered by different accepted branches.
    if (p.inner.kind === 'UNION') return p.inner.types.flatMap(t => wireInclusion(wrap(t,p.nullable,p.optional), accepted, path, depth + 1));
    if (p.inner.kind === 'ENUM') return p.inner.values.flatMap(value => wireInclusion(wrap({kind:'LITERAL',value},p.nullable,p.optional), accepted, path, depth + 1));
    return [issue(path, 'no accepted union branch covers produced values', p.inner.kind, 'UNION', trials.some(t => t.some(i => i.unresolved)))];
  }
  const issues: WireIssue[] = [];
  if (p.nullable && !a.nullable) issues.push(issue(path, 'consumer does not accept null', 'non-null', 'nullable'));
  if (p.optional && !a.optional) issues.push(issue(path, 'consumer does not accept omission', 'required', 'optional'));
  const x = p.inner, y = a.inner;
  if (x.kind === 'UNION') return [...issues, ...x.types.flatMap(t => wireInclusion(t, accepted, path, depth + 1))];
  if (x.kind === 'ENUM') return [...issues, ...x.values.flatMap(value => wireInclusion({kind:'LITERAL',value}, y, path, depth + 1))];
  if (x.kind === 'LITERAL') {
    const ok = y.kind === 'LITERAL' ? x.value === y.value : y.kind === 'ENUM' ? y.values.includes(x.value as string | number) : y.kind === 'PRIMITIVE' && typeof x.value === y.scalar;
    return ok ? issues : [...issues, issue(path, 'literal value is rejected', JSON.stringify(x.value), y.kind)];
  }
  if (x.kind === 'PRIMITIVE' && y.kind === 'PRIMITIVE') return x.scalar === y.scalar ? issues : [...issues, issue(path, 'primitive type mismatch', y.scalar, x.scalar)];
  if (x.kind === 'ARRAY' && y.kind === 'ARRAY') return [...issues, ...wireInclusion(x.elementType, y.elementType, `${path}[]`, depth + 1)];
  if (x.kind === 'OBJECT' && y.kind === 'OBJECT') {
    const supplied = new Map(x.properties.map(p => [p.wireName,p]));
    const required = new Map(y.properties.map(p => [p.wireName,p]));
    for (const [name, target] of required) {
      const source = supplied.get(name);
      if (!source) { if (!unwrap(propertyType(target)).optional) issues.push(issue(`${path}.${name}`, 'required field is absent', 'required', 'missing')); continue; }
      issues.push(...wireInclusion(propertyType(source), propertyType(target), `${path}.${name}`, depth + 1));
      for (const constraint of target.validationConstraints) {
        if (!source.validationConstraints.some(c => c.kind === constraint.kind && c.value === constraint.value)) issues.push(issue(`${path}.${name}`, `unresolved accepted constraint ${constraint.kind}`, 'constraint', 'unproven', true));
      }
    }
    if (y.strict) for (const name of supplied.keys()) if (!required.has(name)) issues.push(issue(`${path}.${name}`, 'strict decoder rejects extra field', 'absent', 'added'));
    return issues;
  }
  if (x.kind === 'MAP' && y.kind === 'MAP') return [...issues, ...wireInclusion(x.keyType,y.keyType,`${path}.key`,depth+1), ...wireInclusion(x.valueType, y.valueType, `${path}.*`, depth + 1)];
  if (x.kind === y.kind) return [...issues, issue(path, 'unsupported wire inclusion', x.kind, y.kind, true)];
  return [...issues, issue(path, 'shape mismatch', y.kind, x.kind)];
}
