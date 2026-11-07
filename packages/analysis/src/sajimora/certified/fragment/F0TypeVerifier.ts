import ts from 'typescript';

export type F0ScalarType =
  | { kind: 'never' }
  | { kind: 'primitive'; name: 'string' | 'number' | 'boolean' | 'null' | 'undefined' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'union'; types: F0ScalarType[] };

export interface F0RecordProperty {
  readonly: true;
  type: F0ScalarType;
}

export interface F0RecordType {
  kind: 'record';
  name?: string;
  properties: Map<string, F0RecordProperty>;
}

export interface F0Parameter {
  name: string;
  type: F0ScalarType | F0RecordType;
}

export interface F0Signature {
  kind: 'signature';
  name: string;
  parameters: F0Parameter[];
  returnType: F0ScalarType | F0RecordType | { kind: 'void' };
}

export type F0Type = F0ScalarType | F0RecordType | { kind: 'void' };

export class F0TypeVerifier {
  /**
   * Normalizes a scalar type:
   * - Flattens nested unions
   * - Deduplicates identical members
   * - Absorbs true | false -> boolean
   * - Absorbs literal types into their matching primitive (e.g. string | 'a' -> string)
   * - Absorbs never in unions (e.g. never | T -> T)
   * - Preserves -0 distinctions
   */
  public static normalizeScalar(type: F0ScalarType): F0ScalarType {
    if (type.kind !== 'union') {
      return type;
    }

    // 1. Flatten all union members
    const flattened: F0ScalarType[] = [];
    const collect = (t: F0ScalarType) => {
      if (t.kind === 'union') {
        for (const child of t.types) collect(child);
      } else if (t.kind !== 'never') {
        flattened.push(t);
      }
    };
    for (const t of type.types) {
      collect(t);
    }

    if (flattened.length === 0) {
      return { kind: 'never' };
    }

    // 2. Check for primitives present to absorb matching literals
    let hasStringPrimitive = false;
    let hasNumberPrimitive = false;
    let hasBooleanPrimitive = false;
    let hasTrueLiteral = false;
    let hasFalseLiteral = false;

    for (const item of flattened) {
      if (item.kind === 'primitive') {
        if (item.name === 'string') hasStringPrimitive = true;
        if (item.name === 'number') hasNumberPrimitive = true;
        if (item.name === 'boolean') hasBooleanPrimitive = true;
      } else if (item.kind === 'literal') {
        if (item.value === true) hasTrueLiteral = true;
        if (item.value === false) hasFalseLiteral = true;
      }
    }

    if (hasTrueLiteral && hasFalseLiteral) {
      hasBooleanPrimitive = true;
    }

    // 3. Filter and deduplicate
    const uniqueMap = new Map<string, F0ScalarType>();

    for (const item of flattened) {
      if (item.kind === 'literal') {
        if (typeof item.value === 'string' && hasStringPrimitive) continue;
        if (typeof item.value === 'number' && hasNumberPrimitive) continue;
        if (typeof item.value === 'boolean' && hasBooleanPrimitive) continue;
      }
      if (item.kind === 'primitive' && item.name === 'boolean' && !uniqueMap.has('prim:boolean')) {
        uniqueMap.set('prim:boolean', { kind: 'primitive', name: 'boolean' });
        continue;
      }

      const key = F0TypeVerifier.canonicalScalarKey(item);
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, item);
      }
    }

    if (hasBooleanPrimitive && !uniqueMap.has('prim:boolean')) {
      uniqueMap.set('prim:boolean', { kind: 'primitive', name: 'boolean' });
    }

    const normalizedMembers = Array.from(uniqueMap.values());
    if (normalizedMembers.length === 0) {
      return { kind: 'never' };
    }
    if (normalizedMembers.length === 1) {
      return normalizedMembers[0];
    }

    normalizedMembers.sort((a, b) => {
      const ka = F0TypeVerifier.canonicalScalarKey(a);
      const kb = F0TypeVerifier.canonicalScalarKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    return { kind: 'union', types: normalizedMembers };
  }

  public static canonicalScalarKey(t: F0ScalarType): string {
    switch (t.kind) {
      case 'never':
        return 'never';
      case 'primitive':
        return `prim:${t.name}`;
      case 'literal':
        if (typeof t.value === 'number' && Object.is(t.value, -0)) {
          return 'lit:num:-0';
        }
        return `lit:${typeof t.value}:${t.value}`;
      case 'union':
        return `union:[${t.types.map(F0TypeVerifier.canonicalScalarKey).join(',')}]`;
    }
  }

  /**
   * Tests whether source is a subtype of target in the F0 scalar algebra.
   */
  public static isScalarSubtype(source: F0ScalarType, target: F0ScalarType): boolean {
    const normSource = F0TypeVerifier.normalizeScalar(source);
    const normTarget = F0TypeVerifier.normalizeScalar(target);

    if (normSource.kind === 'never') {
      return true;
    }

    if (normSource.kind === 'union') {
      // Every alternative in source must be covered by target
      for (const alt of normSource.types) {
        if (!F0TypeVerifier.isScalarSubtype(alt, normTarget)) {
          return false;
        }
      }
      return true;
    }

    if (normTarget.kind === 'union') {
      // Source must fit into at least one alternative or be covered by target
      for (const alt of normTarget.types) {
        if (F0TypeVerifier.isScalarSubtype(normSource, alt)) {
          return true;
        }
      }
      return false;
    }

    // Primitive target
    if (normTarget.kind === 'primitive') {
      if (normSource.kind === 'primitive') {
        return normSource.name === normTarget.name;
      }
      if (normSource.kind === 'literal') {
        return typeof normSource.value === normTarget.name;
      }
      return false;
    }

    // Literal target
    if (normTarget.kind === 'literal') {
      if (normSource.kind === 'literal') {
        if (typeof normSource.value === 'number' && typeof normTarget.value === 'number') {
          return Object.is(normSource.value, normTarget.value);
        }
        return normSource.value === normTarget.value;
      }
      return false;
    }

    return false;
  }

  /**
   * Extracts F0ScalarType from a TypeScript TypeNode.
   */
  public static extractScalarType(
    node: ts.TypeNode,
    aliasResolver: (name: string) => F0Type | undefined
  ): { valid: true; type: F0ScalarType } | { valid: false; reason: string } {
    if (ts.isLiteralTypeNode(node)) {
      const lit = node.literal;
      if (ts.isStringLiteral(lit)) {
        return { valid: true, type: { kind: 'literal', value: lit.text } };
      }
      if (ts.isNumericLiteral(lit)) {
        const val = Number(lit.text);
        const isNegZero = lit.text === '-0' || Object.is(val, -0);
        return { valid: true, type: { kind: 'literal', value: isNegZero ? -0 : val } };
      }
      if (lit.kind === ts.SyntaxKind.TrueKeyword) {
        return { valid: true, type: { kind: 'literal', value: true } };
      }
      if (lit.kind === ts.SyntaxKind.FalseKeyword) {
        return { valid: true, type: { kind: 'literal', value: false } };
      }
      if (lit.kind === ts.SyntaxKind.NullKeyword) {
        return { valid: true, type: { kind: 'primitive', name: 'null' } };
      }
      return { valid: false, reason: `Unsupported literal type: ${ts.SyntaxKind[lit.kind]}` };
    }

    if (node.kind === ts.SyntaxKind.StringKeyword) return { valid: true, type: { kind: 'primitive', name: 'string' } };
    if (node.kind === ts.SyntaxKind.NumberKeyword) return { valid: true, type: { kind: 'primitive', name: 'number' } };
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return { valid: true, type: { kind: 'primitive', name: 'boolean' } };
    if (node.kind === ts.SyntaxKind.NeverKeyword) return { valid: true, type: { kind: 'never' } };
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) return { valid: true, type: { kind: 'primitive', name: 'undefined' } };

    if (ts.isUnionTypeNode(node)) {
      const members: F0ScalarType[] = [];
      for (const member of node.types) {
        const res = F0TypeVerifier.extractScalarType(member, aliasResolver);
        if (!res.valid) return res;
        members.push(res.type);
      }
      return { valid: true, type: F0TypeVerifier.normalizeScalar({ kind: 'union', types: members }) };
    }

    if (ts.isTypeReferenceNode(node)) {
      const aliasName = node.typeName.getText();
      const resolved = aliasResolver(aliasName);
      if (!resolved) {
        return { valid: false, reason: `Unresolved type reference: ${aliasName}` };
      }
      if (resolved.kind === 'record' || resolved.kind === 'void') {
        return { valid: false, reason: `Type reference ${aliasName} resolves to non-scalar type (${resolved.kind})` };
      }
      return { valid: true, type: resolved };
    }

    return { valid: false, reason: `Unsupported type node kind: ${ts.SyntaxKind[node.kind]}` };
  }

  /** Extracts the narrow sealed structural F0 type algebra. */
  public static extractType(
    node: ts.TypeNode,
    aliasResolver: (name: string) => F0Type | undefined
  ): { valid: true; type: F0Type } | { valid: false; reason: string } {
    if (!ts.isTypeLiteralNode(node)) {
      return this.extractScalarType(node, aliasResolver);
    }
    const properties = new Map<string, F0RecordProperty>();
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !ts.isIdentifier(member.name) || member.questionToken || !member.type) {
        return { valid: false, reason: 'Type literal contains an unsupported member' };
      }
      if (!(member.modifiers?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false)) {
        return { valid: false, reason: `Type literal property '${member.name.text}' must be readonly` };
      }
      const scalar = this.extractScalarType(member.type, aliasResolver);
      if (!scalar.valid) return scalar;
      properties.set(member.name.text, { readonly: true, type: scalar.type });
    }
    if (properties.size === 0) return { valid: false, reason: 'Empty type literals are unsupported in F0' };
    const ordered = new Map<string, F0RecordProperty>();
    for (const name of Array.from(properties.keys()).sort()) ordered.set(name, properties.get(name)!);
    return { valid: true, type: { kind: 'record', properties: ordered } };
  }

  public static extractSignature(
    node: ts.FunctionDeclaration,
    aliasResolver: (name: string) => F0Type | undefined
  ): { valid: true; signature: F0Signature } | { valid: false; reason: string } {
    if (!node.name || !node.type) return { valid: false, reason: 'Function requires a name and explicit return type' };
    const extractValueType = (typeNode: ts.TypeNode): { valid: true; type: F0Type } | { valid: false; reason: string } => {
      if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
        const resolved = aliasResolver(typeNode.typeName.text);
        return resolved ? { valid: true, type: resolved } : { valid: false, reason: `Unresolved type reference: ${typeNode.typeName.text}` };
      }
      return this.extractType(typeNode, aliasResolver);
    };
    const parameters: F0Parameter[] = [];
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name) || parameter.questionToken || parameter.dotDotDotToken || parameter.initializer || !parameter.type) {
        return { valid: false, reason: 'Function parameters must be named, required, non-rest, and explicitly typed' };
      }
      const type = extractValueType(parameter.type);
      if (!type.valid) return type;
      if (type.type.kind === 'void') return { valid: false, reason: 'Parameter type cannot be void' };
      parameters.push({ name: parameter.name.text, type: type.type });
    }
    const returnType = extractValueType(node.type);
    if (!returnType.valid) return returnType;
    return { valid: true, signature: { kind: 'signature', name: node.name.text, parameters, returnType: returnType.type } };
  }

  /**
   * Topologically sorts type aliases and detects cycles.
   * Returns sorted alias names in dependency order (leaves first).
   */
  public static topologicalSortAliases(
    aliases: Map<string, string[]> // aliasName -> referenced alias names
  ): { valid: true; order: string[] } | { valid: false; cycle: string[] } {
    const visited = new Map<string, 'VISITING' | 'VISITED'>();
    const order: string[] = [];
    const path: string[] = [];
    let detectedCycle: string[] | null = null;

    const dfs = (node: string): boolean => {
      if (detectedCycle) return false;
      const state = visited.get(node);
      if (state === 'VISITING') {
        const cycleStart = path.indexOf(node);
        detectedCycle = path.slice(cycleStart).concat(node);
        return false;
      }
      if (state === 'VISITED') return true;

      visited.set(node, 'VISITING');
      path.push(node);

      const deps = aliases.get(node) || [];
      for (const dep of deps) {
        if (aliases.has(dep)) {
          if (!dfs(dep)) return false;
        }
      }

      path.pop();
      visited.set(node, 'VISITED');
      order.push(node);
      return true;
    };

    // Sort alias names for deterministic traversal
    const sortedKeys = Array.from(aliases.keys()).sort();
    for (const key of sortedKeys) {
      if (!visited.has(key)) {
        if (!dfs(key)) {
          return { valid: false, cycle: detectedCycle || [key] };
        }
      }
    }

    return { valid: true, order };
  }
}
