import { describe, it, expect } from 'vitest';
import {
  compareDirectionalWire,
  toInputWireType,
  toOutputWireType,
} from '../../../src/sajimora/cross-language/DirectionalWireCompatibility';
import { TypeScriptContractParser } from '../../../src/sajimora/cross-language/TypeScriptContractParser';
import { WireType } from '../../../src/sajimora/cross-language/CanonicalContractIR';

describe('Zod directional input/output validation', () => {
  // Helper to parse a TS source snippet and get WireType
  function parseZod(name: string, source: string): WireType {
    const parser = new TypeScriptContractParser(new Map([['test.ts', source]]));
    const result = parser.parseTypeByName(name, 'test.ts');
    return result.wireType;
  }

  describe('1. Response direction (PRODUCER_TO_CONSUMER)', () => {
    it('producer emits payload lacking property foo -> consumer with z.object({ foo: z.string().default("bar") }) passes', () => {
      const code = `
        import { z } from 'zod';
        export const ConsumerSchema = z.object({
          foo: z.string().default('bar')
        });
      `;
      const consumer = parseZod('ConsumerSchema', code);
      const producer: WireType = {
        kind: 'OBJECT',
        properties: [],
      };

      const result = compareDirectionalWire(producer, consumer, 'PRODUCER_TO_CONSUMER');
      expect(result.mismatches).toHaveLength(0);
      expect(result.unresolved).toHaveLength(0);
    });

    it('consumer lacking default fails when producer omits property foo', () => {
      const code = `
        import { z } from 'zod';
        export const ConsumerRequired = z.object({
          foo: z.string()
        });
      `;
      const consumer = parseZod('ConsumerRequired', code);
      const producer: WireType = {
        kind: 'OBJECT',
        properties: [],
      };

      const result = compareDirectionalWire(producer, consumer, 'PRODUCER_TO_CONSUMER');
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0]).toMatchObject({
        path: '$.foo',
        supplied: 'missing property',
        accepted: 'required property',
      });
    });

    it('producer emitting foo with wrong type still fails (preserves type invariants)', () => {
      const code = `
        import { z } from 'zod';
        export const ConsumerSchema = z.object({
          foo: z.string().default('bar')
        });
      `;
      const consumer = parseZod('ConsumerSchema', code);
      const producer: WireType = {
        kind: 'OBJECT',
        properties: [
          {
            wireName: 'foo',
            type: { kind: 'PRIMITIVE', scalar: 'number' },
            optional: false,
            nullable: false,
            validationConstraints: [],
          },
        ],
      };

      const result = compareDirectionalWire(producer, consumer, 'PRODUCER_TO_CONSUMER');
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0]).toMatchObject({
        path: '$.foo',
        supplied: 'number',
        accepted: 'string',
      });
    });

    it('strict consumer with default accepts missing defaulted property but rejects extra properties', () => {
      const code = `
        import { z } from 'zod';
        export const StrictConsumer = z.object({
          foo: z.string().default('bar')
        }).strict();
      `;
      const consumer = parseZod('StrictConsumer', code);
      const producerWithExtra: WireType = {
        kind: 'OBJECT',
        properties: [
          {
            wireName: 'unexpected',
            type: { kind: 'PRIMITIVE', scalar: 'string' },
            optional: false,
            nullable: false,
            validationConstraints: [],
          },
        ],
      };

      const result = compareDirectionalWire(producerWithExtra, consumer, 'PRODUCER_TO_CONSUMER');
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0]).toMatchObject({
        path: '$.unexpected',
        supplied: 'extra property',
        accepted: 'strict object (.strict())',
      });
    });
  });

  describe('2. Request body direction (CONSUMER_TO_PRODUCER)', () => {
    const producerRequiringFoo: WireType = {
      kind: 'OBJECT',
      properties: [
        {
          wireName: 'foo',
          type: { kind: 'PRIMITIVE', scalar: 'string' },
          optional: false,
          nullable: false,
          validationConstraints: [],
        },
      ],
    };

    const schemaCode = `
      import { z } from 'zod';
      export const ClientSchema = z.object({
        foo: z.string().default('bar')
      });
    `;

    it('consumer sending pre-default input lacking foo fails', () => {
      const preDefaultInput: WireType = {
        kind: 'OBJECT',
        properties: [],
      };

      const result = compareDirectionalWire(preDefaultInput, producerRequiringFoo, 'CONSUMER_TO_PRODUCER');
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0]).toMatchObject({
        path: '$.foo',
        supplied: 'missing property',
        accepted: 'required property',
      });
    });

    it('consumer sending pre-default input with optional foo fails with possibly omitted', () => {
      const clientSchema = parseZod('ClientSchema', schemaCode);
      const preDefaultInput = toInputWireType(clientSchema);

      const result = compareDirectionalWire(preDefaultInput, producerRequiringFoo, {
        direction: 'CONSUMER_TO_PRODUCER',
        parsesOutboundData: false,
      });
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0]).toMatchObject({
        path: '$.foo',
        supplied: 'possibly omitted',
        accepted: 'required property',
      });
    });

    it('consumer sending post-parse output with guaranteed default succeeds', () => {
      const clientSchema = parseZod('ClientSchema', schemaCode);
      const postParseOutput = toOutputWireType(clientSchema);

      const result = compareDirectionalWire(postParseOutput, producerRequiringFoo, 'CONSUMER_TO_PRODUCER');
      expect(result.mismatches).toHaveLength(0);
      expect(result.unresolved).toHaveLength(0);
    });

    it('evaluating schema with parsesOutboundData=true succeeds', () => {
      const clientSchema = parseZod('ClientSchema', schemaCode);
      const result = compareDirectionalWire(clientSchema, producerRequiringFoo, {
        direction: 'CONSUMER_TO_PRODUCER',
        parsesOutboundData: true,
      });
      expect(result.mismatches).toHaveLength(0);
    });

    it('evaluating schema with parsesOutboundData=false fails', () => {
      const clientSchema = parseZod('ClientSchema', schemaCode);
      const result = compareDirectionalWire(clientSchema, producerRequiringFoo, {
        direction: 'CONSUMER_TO_PRODUCER',
        parsesOutboundData: false,
      });
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0]).toMatchObject({
        path: '$.foo',
        supplied: 'possibly omitted',
        accepted: 'required property',
      });
    });
  });

  describe('3. Permutations of .default(), .optional(), .nullable(), and .nullish()', () => {
    it('.default() alone: optional on input, required on output', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().default('def') });
      `;
      const schema = parseZod('S', code);
      const inType = toInputWireType(schema);
      const outType = toOutputWireType(schema);

      expect(inType.kind).toBe('OBJECT');
      expect((inType as any).properties[0].optional).toBe(true);
      expect((inType as any).properties[0].nullable).toBe(false);

      expect(outType.kind).toBe('OBJECT');
      expect((outType as any).properties[0].optional).toBe(false);
      expect((outType as any).properties[0].nullable).toBe(false);
    });

    it('.optional() alone: optional on input and output, no default', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().optional() });
      `;
      const schema = parseZod('S', code);
      const inType = toInputWireType(schema);
      const outType = toOutputWireType(schema);

      expect((inType as any).properties[0].optional).toBe(true);
      expect((inType as any).properties[0].hasDefault).toBeUndefined();
      expect((outType as any).properties[0].optional).toBe(true);
    });

    it('.nullable() alone: required on input and output, nullable on both', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().nullable() });
      `;
      const schema = parseZod('S', code);
      const inType = toInputWireType(schema);
      const outType = toOutputWireType(schema);

      expect((inType as any).properties[0].optional).toBe(false);
      expect((inType as any).properties[0].nullable).toBe(true);
      expect((outType as any).properties[0].optional).toBe(false);
      expect((outType as any).properties[0].nullable).toBe(true);
    });

    it('.nullish() alone: optional and nullable on input and output', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().nullish() });
      `;
      const schema = parseZod('S', code);
      const inType = toInputWireType(schema);
      const outType = toOutputWireType(schema);

      expect((inType as any).properties[0].optional).toBe(true);
      expect((inType as any).properties[0].nullable).toBe(true);
      expect((outType as any).properties[0].optional).toBe(true);
      expect((outType as any).properties[0].nullable).toBe(true);
    });

    it('.optional().default(): outer default makes output required', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().optional().default('bar') });
      `;
      const schema = parseZod('S', code);
      const inType = toInputWireType(schema);
      const outType = toOutputWireType(schema);

      expect((inType as any).properties[0].optional).toBe(true);
      expect((outType as any).properties[0].optional).toBe(false);

      // In CONSUMER_TO_PRODUCER, post-parse output satisfies a required producer property
      const producer: WireType = {
        kind: 'OBJECT',
        properties: [{ wireName: 'x', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] }],
      };
      expect(compareDirectionalWire(outType, producer, 'CONSUMER_TO_PRODUCER').mismatches).toHaveLength(0);
    });

    it('.default().optional(): outer optional preserves optional on output', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().default('bar').optional() });
      `;
      const schema = parseZod('S', code);
      const inType = toInputWireType(schema);
      const outType = toOutputWireType(schema);

      expect((inType as any).properties[0].optional).toBe(true);
      expect((outType as any).properties[0].optional).toBe(true);

      // In CONSUMER_TO_PRODUCER, post-parse output fails against required property because outer .optional() allows undefined
      const producer: WireType = {
        kind: 'OBJECT',
        properties: [{ wireName: 'x', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] }],
      };
      const cmp = compareDirectionalWire(outType, producer, 'CONSUMER_TO_PRODUCER');
      expect(cmp.mismatches).toHaveLength(1);
      expect(cmp.mismatches[0].supplied).toBe('possibly omitted');
    });

    it('.nullable().default(): optional on input, required & nullable on output', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().nullable().default('bar') });
      `;
      const schema = parseZod('S', code);
      const inType = toInputWireType(schema);
      const outType = toOutputWireType(schema);

      expect((inType as any).properties[0].optional).toBe(true);
      expect((inType as any).properties[0].nullable).toBe(true);
      expect((outType as any).properties[0].optional).toBe(false);
      expect((outType as any).properties[0].nullable).toBe(true);

      // In response direction, producer sending null is accepted
      const nullProducer: WireType = {
        kind: 'OBJECT',
        properties: [{ wireName: 'x', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: true, validationConstraints: [] }],
      };
      expect(compareDirectionalWire(nullProducer, schema, 'PRODUCER_TO_CONSUMER').mismatches).toHaveLength(0);

      // Producer omitting property is accepted due to default
      const emptyProducer: WireType = { kind: 'OBJECT', properties: [] };
      expect(compareDirectionalWire(emptyProducer, schema, 'PRODUCER_TO_CONSUMER').mismatches).toHaveLength(0);
    });

    it('.default().nullable(): nullable and optional on input, required & nullable on output', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().default('bar').nullable() });
      `;
      const schema = parseZod('S', code);
      const outType = toOutputWireType(schema);

      expect((outType as any).properties[0].optional).toBe(false);
      expect((outType as any).properties[0].nullable).toBe(true);
    });

    it('.nullish().default(): optional on input, required & nullable on output', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().nullish().default('bar') });
      `;
      const schema = parseZod('S', code);
      const inType = toInputWireType(schema);
      const outType = toOutputWireType(schema);

      expect((inType as any).properties[0].optional).toBe(true);
      expect((inType as any).properties[0].nullable).toBe(true);
      expect((outType as any).properties[0].optional).toBe(false);
      expect((outType as any).properties[0].nullable).toBe(true);
    });

    it('.default().nullish(): optional and nullable on input and output', () => {
      const code = `
        import { z } from 'zod';
        export const S = z.object({ x: z.string().default('bar').nullish() });
      `;
      const schema = parseZod('S', code);
      const outType = toOutputWireType(schema);

      expect((outType as any).properties[0].optional).toBe(true);
      expect((outType as any).properties[0].nullable).toBe(true);
    });
  });

  describe('4. Permutations of .extend() and .merge()', () => {
    it('.extend() adding a defaulted property preserves existing and new defaults', () => {
      const code = `
        import { z } from 'zod';
        const Base = z.object({ id: z.number() });
        export const Extended = Base.extend({
          foo: z.string().default('bar')
        });
      `;
      const schema = parseZod('Extended', code);
      const inType = toInputWireType(schema);
      const outType = toOutputWireType(schema);

      // Producer emits only { id: 1 } without foo -> passes in response direction
      const producer: WireType = {
        kind: 'OBJECT',
        properties: [{ wireName: 'id', type: { kind: 'PRIMITIVE', scalar: 'number' }, optional: false, nullable: false, validationConstraints: [] }],
      };
      expect(compareDirectionalWire(producer, schema, 'PRODUCER_TO_CONSUMER').mismatches).toHaveLength(0);

      // Producer requiring both id and foo
      const strictProducer: WireType = {
        kind: 'OBJECT',
        properties: [
          { wireName: 'id', type: { kind: 'PRIMITIVE', scalar: 'number' }, optional: false, nullable: false, validationConstraints: [] },
          { wireName: 'foo', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] },
        ],
      };
      // Pre-default fails
      expect(compareDirectionalWire(inType, strictProducer, { direction: 'CONSUMER_TO_PRODUCER', parsesOutboundData: false }).mismatches).toHaveLength(1);
      // Post-parse succeeds
      expect(compareDirectionalWire(outType, strictProducer, 'CONSUMER_TO_PRODUCER').mismatches).toHaveLength(0);
    });

    it('.extend() overriding a required property with a defaulted property', () => {
      const code = `
        import { z } from 'zod';
        const Base = z.object({ foo: z.string() });
        export const Extended = Base.extend({
          foo: z.string().default('defaultVal')
        });
      `;
      const schema = parseZod('Extended', code);
      const emptyProducer: WireType = { kind: 'OBJECT', properties: [] };

      // Producer lacking foo passes because extend updated foo to have default
      expect(compareDirectionalWire(emptyProducer, schema, 'PRODUCER_TO_CONSUMER').mismatches).toHaveLength(0);
    });

    it('.extend() overriding a defaulted property with a required property removes default', () => {
      const code = `
        import { z } from 'zod';
        const Base = z.object({ foo: z.string().default('defaultVal') });
        export const Extended = Base.extend({
          foo: z.string()
        });
      `;
      const schema = parseZod('Extended', code);
      const emptyProducer: WireType = { kind: 'OBJECT', properties: [] };

      // Producer lacking foo fails because extend made foo required again
      const result = compareDirectionalWire(emptyProducer, schema, 'PRODUCER_TO_CONSUMER');
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0]).toMatchObject({
        path: '$.foo',
        supplied: 'missing property',
        accepted: 'required property',
      });
    });

    it('.merge() merging two schemas with defaults preserves defaults from both', () => {
      const code = `
        import { z } from 'zod';
        const S1 = z.object({ a: z.string().default('aVal') });
        const S2 = z.object({ b: z.number().default(42) });
        export const Merged = S1.merge(S2);
      `;
      const schema = parseZod('Merged', code);
      const emptyProducer: WireType = { kind: 'OBJECT', properties: [] };

      // Producer lacking both a and b passes in response direction
      expect(compareDirectionalWire(emptyProducer, schema, 'PRODUCER_TO_CONSUMER').mismatches).toHaveLength(0);

      // Post-parse output guarantees both a and b
      const outType = toOutputWireType(schema);
      const producerRequiringBoth: WireType = {
        kind: 'OBJECT',
        properties: [
          { wireName: 'a', type: { kind: 'PRIMITIVE', scalar: 'string' }, optional: false, nullable: false, validationConstraints: [] },
          { wireName: 'b', type: { kind: 'PRIMITIVE', scalar: 'number' }, optional: false, nullable: false, validationConstraints: [] },
        ],
      };
      expect(compareDirectionalWire(outType, producerRequiringBoth, 'CONSUMER_TO_PRODUCER').mismatches).toHaveLength(0);
    });

    it('.merge() where second schema overrides defaulted property with required property', () => {
      const code = `
        import { z } from 'zod';
        const S1 = z.object({ foo: z.string().default('aVal') });
        const S2 = z.object({ foo: z.string() });
        export const Merged = S1.merge(S2);
      `;
      const schema = parseZod('Merged', code);
      const emptyProducer: WireType = { kind: 'OBJECT', properties: [] };

      // Fails because S2 overrode foo to be required
      const result = compareDirectionalWire(emptyProducer, schema, 'PRODUCER_TO_CONSUMER');
      expect(result.mismatches).toHaveLength(1);
      expect(result.mismatches[0].path).toBe('$.foo');
    });

    it('.merge() with object literal containing default', () => {
      const code = `
        import { z } from 'zod';
        const S1 = z.object({ a: z.string().default('aVal') });
        export const Merged = S1.merge(z.object({
          extra: z.boolean().default(true)
        }));
      `;
      const schema = parseZod('Merged', code);
      const emptyProducer: WireType = { kind: 'OBJECT', properties: [] };

      expect(compareDirectionalWire(emptyProducer, schema, 'PRODUCER_TO_CONSUMER').mismatches).toHaveLength(0);
    });
  });

  describe('5. Nested objects and z.input / z.output type references', () => {
    it('nested object defaults: child default accepts missing child property in response direction', () => {
      const code = `
        import { z } from 'zod';
        export const NestedSchema = z.object({
          config: z.object({
            retries: z.number().default(3),
            timeout: z.number()
          })
        });
      `;
      const schema = parseZod('NestedSchema', code);

      // Producer provides config with timeout, but omits retries
      const producer: WireType = {
        kind: 'OBJECT',
        properties: [
          {
            wireName: 'config',
            type: {
              kind: 'OBJECT',
              properties: [
                { wireName: 'timeout', type: { kind: 'PRIMITIVE', scalar: 'number' }, optional: false, nullable: false, validationConstraints: [] },
              ],
            },
            optional: false,
            nullable: false,
            validationConstraints: [],
          },
        ],
      };

      expect(compareDirectionalWire(producer, schema, 'PRODUCER_TO_CONSUMER').mismatches).toHaveLength(0);

      // Producer completely lacking config (required parent) fails
      const lackingConfig: WireType = { kind: 'OBJECT', properties: [] };
      const res = compareDirectionalWire(lackingConfig, schema, 'PRODUCER_TO_CONSUMER');
      expect(res.mismatches).toHaveLength(1);
      expect(res.mismatches[0].path).toBe('$.config');
    });

    it('z.input<typeof Schema> and z.output<typeof Schema> parsed via TypeScriptContractParser', () => {
      const code = `
        import { z } from 'zod';
        export const Schema = z.object({
          name: z.string(),
          role: z.string().default('user')
        });
        export type MyInput = z.input<typeof Schema>;
        export type MyOutput = z.output<typeof Schema>;
      `;
      const parser = new TypeScriptContractParser(new Map([['test.ts', code]]));
      const inType = parser.parseTypeByName('MyInput', 'test.ts').wireType;
      const outType = parser.parseTypeByName('MyOutput', 'test.ts').wireType;

      expect(inType.kind).toBe('OBJECT');
      if (inType.kind === 'OBJECT') {
        const role = inType.properties.find(p => p.wireName === 'role');
        expect(role?.optional).toBe(true);
      }

      expect(outType.kind).toBe('OBJECT');
      if (outType.kind === 'OBJECT') {
        const role = outType.properties.find(p => p.wireName === 'role');
        expect(role?.optional).toBe(false);
      }
    });
  });
});
