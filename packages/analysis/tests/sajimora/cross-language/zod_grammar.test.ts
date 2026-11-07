/**
 * Zod Grammar Extension Tests
 * Pinned Zod dependency version in package.json: ^3.23.8 (installed: 3.25.76)
 */

import { describe, it, expect } from 'vitest';
import { TypeScriptContractParser } from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import {
  EnumWireType,
  UnionWireType,
  LiteralWireType,
  ObjectWireType,
} from '../../../src/sajimora/cross-language/CanonicalContractIR';

function parse(source: string, typeName = 'Schema') {
  const parser = new TypeScriptContractParser(new Map([['schema.ts', source]]));
  return parser.parseTypeByName(typeName, 'schema.ts');
}

describe('Zod Grammar Extension (B4)', () => {
  it('parses z.enum with string literal values to EnumWireType', () => {
    const result = parse("const Schema = z.enum(['A', 'B']);");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('ENUM');
    const enumWire = result.wireType as EnumWireType;
    expect(enumWire.values).toEqual(['A', 'B']);
    expect(enumWire.provenance?.annotationOrSchema).toBe('ZodSchema');
  });

  it('parses z.enum inside z.object field', () => {
    const result = parse("const Schema = z.object({ role: z.enum(['ADMIN', 'USER']) });");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');
    const objWire = result.wireType as ObjectWireType;
    expect(objWire.properties).toHaveLength(1);
    const prop = objWire.properties[0];
    expect(prop.wireName).toBe('role');
    expect(prop.type.kind).toBe('ENUM');
    expect((prop.type as EnumWireType).values).toEqual(['ADMIN', 'USER']);
  });

  it('parses z.union([z.string(), z.number()]) to UnionWireType with 2 members', () => {
    const result = parse("const Schema = z.union([z.string(), z.number()]);");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('UNION');
    const unionWire = result.wireType as UnionWireType;
    expect(unionWire.types).toHaveLength(2);
    expect(unionWire.types[0]).toMatchObject({ kind: 'PRIMITIVE', scalar: 'string' });
    expect(unionWire.types[1]).toMatchObject({ kind: 'PRIMITIVE', scalar: 'number' });
  });

  it('parses z.literal with string literal value to LiteralWireType', () => {
    const result = parse("const Schema = z.literal('foo');");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('LITERAL');
    const litWire = result.wireType as LiteralWireType;
    expect(litWire.value).toBe('foo');
  });

  it('parses z.literal with numeric literal value to LiteralWireType', () => {
    const result = parse("const Schema = z.literal(42);");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('LITERAL');
    const litWire = result.wireType as LiteralWireType;
    expect(litWire.value).toBe(42);
  });

  it('parses z.literal with boolean literal values to LiteralWireType', () => {
    const resTrue = parse("const Schema = z.literal(true);");
    expect(resTrue.blockers).toEqual([]);
    expect(resTrue.wireType.kind).toBe('LITERAL');
    expect((resTrue.wireType as LiteralWireType).value).toBe(true);

    const resFalse = parse("const Schema = z.literal(false);");
    expect(resFalse.blockers).toEqual([]);
    expect(resFalse.wireType.kind).toBe('LITERAL');
    expect((resFalse.wireType as LiteralWireType).value).toBe(false);
  });

  it('parses z.object({name: z.string()}).extend({age: z.number()}) to ObjectWireType with both properties', () => {
    const result = parse("const Schema = z.object({ name: z.string() }).extend({ age: z.number() });");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');
    const objWire = result.wireType as ObjectWireType;
    expect(objWire.properties).toHaveLength(2);
    expect(objWire.properties.map(p => p.wireName)).toEqual(['name', 'age']);
    expect(objWire.properties.find(p => p.wireName === 'name')?.type).toMatchObject({ kind: 'PRIMITIVE', scalar: 'string' });
    expect(objWire.properties.find(p => p.wireName === 'age')?.type).toMatchObject({ kind: 'PRIMITIVE', scalar: 'number' });
  });

  it('.extend() overrides property if same wireName exists in base schema', () => {
    const result = parse("const Schema = z.object({ id: z.string() }).extend({ id: z.number() });");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');
    const objWire = result.wireType as ObjectWireType;
    expect(objWire.properties).toHaveLength(1);
    expect(objWire.properties[0].wireName).toBe('id');
    expect(objWire.properties[0].type).toMatchObject({ kind: 'PRIMITIVE', scalar: 'number' });
  });

  it('parses z.object({a: z.string(), b: z.number()}).pick({a: true}) to ObjectWireType with only property a', () => {
    const result = parse("const Schema = z.object({ a: z.string(), b: z.number() }).pick({ a: true });");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');
    const objWire = result.wireType as ObjectWireType;
    expect(objWire.properties).toHaveLength(1);
    expect(objWire.properties[0].wireName).toBe('a');
    expect(objWire.properties[0].type).toMatchObject({ kind: 'PRIMITIVE', scalar: 'string' });
  });

  it('parses z.object({a: z.string(), b: z.number()}).omit({b: true}) to ObjectWireType with only property a', () => {
    const result = parse("const Schema = z.object({ a: z.string(), b: z.number() }).omit({ b: true });");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');
    const objWire = result.wireType as ObjectWireType;
    expect(objWire.properties).toHaveLength(1);
    expect(objWire.properties[0].wireName).toBe('a');
    expect(objWire.properties[0].type).toMatchObject({ kind: 'PRIMITIVE', scalar: 'string' });
  });

  it('parses .merge() with another z.object schema', () => {
    const result = parse("const Schema = z.object({ a: z.string() }).merge(z.object({ b: z.number() }));");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');
    const objWire = result.wireType as ObjectWireType;
    expect(objWire.properties.map(p => p.wireName)).toEqual(['a', 'b']);
  });

  it('parses .merge() inheriting isStrict from the argument schema', () => {
    const result = parse("const Schema = z.object({ a: z.string() }).merge(z.object({ b: z.number() }).strict());");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');
    const objWire = result.wireType as ObjectWireType;
    expect(objWire.strict).toBe(true);
  });

  it('.default() sets isOptional=true on the field', () => {
    const result = parse("const Schema = z.object({ name: z.string().default('anonymous') });");
    expect(result.blockers).toEqual([]);
    expect(result.wireType.kind).toBe('OBJECT');
    const objWire = result.wireType as ObjectWireType;
    const prop = objWire.properties.find(p => p.wireName === 'name');
    expect(prop).toBeDefined();
    expect(prop?.optional).toBe(true);
  });

  it('emits DYNAMIC_ZOD_SCHEMA when z.enum has non-literal elements', () => {
    const result = parse("const dyn = 'val'; const Schema = z.enum([dyn]);");
    expect(result.wireType.kind).toBe('UNKNOWN');
    expect(result.blockers.some(b => b.code === 'DYNAMIC_ZOD_SCHEMA')).toBe(true);
  });

  it('emits DYNAMIC_ZOD_SCHEMA when z.enum argument is not an array literal', () => {
    const result = parse("const arr = ['A', 'B']; const Schema = z.enum(arr);");
    expect(result.wireType.kind).toBe('UNKNOWN');
    expect(result.blockers.some(b => b.code === 'DYNAMIC_ZOD_SCHEMA')).toBe(true);
  });

  it('emits DYNAMIC_ZOD_SCHEMA when z.union has 0 members or is non-array', () => {
    const resEmpty = parse("const Schema = z.union([]);");
    expect(resEmpty.wireType.kind).toBe('UNKNOWN');
    expect(resEmpty.blockers.some(b => b.code === 'DYNAMIC_ZOD_SCHEMA')).toBe(true);

    const resNonArr = parse("const Schema = z.union('invalid');");
    expect(resNonArr.wireType.kind).toBe('UNKNOWN');
    expect(resNonArr.blockers.some(b => b.code === 'DYNAMIC_ZOD_SCHEMA')).toBe(true);
  });

  it('emits DYNAMIC_ZOD_SCHEMA when z.literal has non-literal argument', () => {
    const result = parse("const dyn = { foo: 'bar' }; const Schema = z.literal(dyn);");
    expect(result.wireType.kind).toBe('UNKNOWN');
    expect(result.blockers.some(b => b.code === 'DYNAMIC_ZOD_SCHEMA')).toBe(true);
  });

  it('emits DYNAMIC_ZOD_SCHEMA when .extend() argument is not an object literal', () => {
    const result = parse("const dyn = 'invalid'; const Schema = z.object({ a: z.string() }).extend(dyn);");
    expect(result.wireType.kind).toBe('UNKNOWN');
    expect(result.blockers.some(b => b.code === 'DYNAMIC_ZOD_SCHEMA')).toBe(true);
  });

  it('emits DYNAMIC_ZOD_SCHEMA when .pick() keys do not map to true', () => {
    const result = parse("const Schema = z.object({ a: z.string(), b: z.number() }).pick({ a: false });");
    expect(result.wireType.kind).toBe('UNKNOWN');
    expect(result.blockers.some(b => b.code === 'DYNAMIC_ZOD_SCHEMA')).toBe(true);
  });

  it('emits UNSUPPORTED_ZOD_TYPE for record and intersection', () => {
    const resRecord = parse("const Schema = z.record(z.string());");
    expect(resRecord.wireType.kind).toBe('UNKNOWN');
    expect(resRecord.blockers.some(b => b.code === 'UNSUPPORTED_ZOD_TYPE')).toBe(true);

    const resIntersection = parse("const Schema = z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }));");
    expect(resIntersection.wireType.kind).toBe('UNKNOWN');
    expect(resIntersection.blockers.some(b => b.code === 'UNSUPPORTED_ZOD_TYPE')).toBe(true);

    const resField = parse("const Schema = z.object({ dict: z.record(z.string()) });");
    expect(resField.blockers.some(b => b.code === 'UNSUPPORTED_ZOD_TYPE')).toBe(true);
  });
});
